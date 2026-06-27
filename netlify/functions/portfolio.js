// Netlify function: fetches IBKR Flex Query reports (positions + dividends/options)
// Caches results using Netlify Blobs to avoid hitting IBKR's per-token rate limit.

const { getStore } = require("@netlify/blobs");

const CACHE_KEY = "portfolio-cache";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getCacheStore() {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (siteID && token) {
    return getStore({ name: "portfolio-data", siteID, token });
  }
  return getStore("portfolio-data");
}

async function fetchFlexReport(token, queryId) {
  const reqUrl = `https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest?t=${token}&q=${queryId}&v=3`;
  const reqRes = await fetch(reqUrl);
  const reqText = await reqRes.text();

  const refMatch = reqText.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/);
  const errMatch = reqText.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);

  if (!refMatch) {
    return { error: errMatch ? errMatch[1] : "Sin código de referencia", raw: reqText.slice(0, 1000) };
  }
  const refCode = refMatch[1];

  let xmlData = null;
  let lastRaw = "";
  let attempts = 0;
  const MAX_ATTEMPTS = 10;
  while (attempts < MAX_ATTEMPTS) {
    await new Promise(r => setTimeout(r, 3000));
    const getUrl = `https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement?q=${refCode}&t=${token}&v=3`;
    const getRes = await fetch(getUrl);
    const text = await getRes.text();
    lastRaw = text;

    if (text.includes("<ErrorMessage>")) {
      const em = text.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);
      if (em && /not yet available|generation in progress|try again|could not be generated/i.test(em[1])) {
        attempts++;
        continue;
      }
      return { error: em ? em[1] : "Error desconocido", raw: text.slice(0, 1000) };
    }
    xmlData = text;
    break;
  }

  if (!xmlData) {
    return { error: `IBKR no generó el informe (query ${queryId}) tras ${MAX_ATTEMPTS} intentos.`, raw: lastRaw.slice(0, 500) };
  }

  return { xml: xmlData };
}

function parseTags(xmlData, tagName) {
  const items = [];
  const regex = new RegExp(`<${tagName}\\b([^>]*?)\\/?>`, "g");
  let match;
  while ((match = regex.exec(xmlData)) !== null) {
    const attrs = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let attr;
    while ((attr = attrRegex.exec(match[1])) !== null) {
      let val = attr[2]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
      attrs[attr[1]] = val;
    }
    items.push(attrs);
  }
  return items;
}

// Parse IBKR option symbol format: "AVGO  270115P00360000" or "TCH DEC26 550 C"
// Returns { underlying, expiry, strike, putCall }
function parseOptionSymbol(sym) {
  if (!sym) return {};

  // US format: "AVGO  270115P00360000"
  // ticker(6) + YYMMDD + P/C + strike*1000 (8 digits)
  const usMatch = sym.trim().match(/^([A-Z]+)\s+(\d{6})([PC])(\d{8})$/);
  if (usMatch) {
    const [, underlying, dateStr, pc, strikePad] = usMatch;
    const yy = dateStr.slice(0, 2);
    const mm = dateStr.slice(2, 4);
    const dd = dateStr.slice(4, 6);
    const strike = parseInt(strikePad, 10) / 1000;
    const months = ["ENE","FEB","MAR","ABR","MAY","JUN","JUL","AGO","SEP","OCT","NOV","DIC"];
    const expiry = `${dd} ${months[parseInt(mm)-1]} 20${yy}`;
    return { underlying, expiry, strike, putCall: pc };
  }

  // HK format: "TCH DEC26 550 C"
  const hkMatch = sym.trim().match(/^(\w+)\s+([A-Z]{3}\d{2})\s+([\d.]+)\s+([PC])$/);
  if (hkMatch) {
    const [, underlying, expiry, strike, pc] = hkMatch;
    return { underlying, expiry, strike: parseFloat(strike), putCall: pc };
  }

  return { underlying: sym.trim() };
}

// Extract options from the main positions array as fallback
function extractOptionsFromPositions(positions) {
  return positions
    .filter(p => p.assetCategory === "OPT")
    .map(p => {
      const parsed = parseOptionSymbol(p.symbol);
      return {
        ...p,
        underlyingSymbol: parsed.underlying || p.symbol,
        expiry: parsed.expiry || "",
        strike: parsed.strike || 0,
        putCall: parsed.putCall || "",
        _source: "positions"
      };
    });
}

// Build today's NAV snapshot from positions to append to navHistory
function buildNavSnapshot(positions) {
  const FX_TO_USD = { USD: 1, EUR: 1.08, HKD: 0.128, GBP: 1.27 };
  const stocks = positions.filter(p => p.assetCategory === "STK" || p.assetCategory === "FUND");
  const nav = stocks.reduce((sum, p) => {
    const fx = FX_TO_USD[p.currency] || 1;
    return sum + (parseFloat(p.positionValue) || 0) * fx;
  }, 0);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return { date: today, nav: Math.round(nav) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      },
      body: ""
    };
  }

  const TOKEN = process.env.IBKR_FLEX_TOKEN;
  const QUERY_ID = process.env.IBKR_QUERY_ID || "1541787";
  const OPTIONS_QUERY_ID = process.env.IBKR_OPTIONS_QUERY_ID || "1495741";
  const forceRefresh = event.queryStringParameters && event.queryStringParameters.force === "1";

  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "IBKR_FLEX_TOKEN no configurado en Netlify Environment Variables" })
    };
  }

  let store = null;
  let blobsAvailable = true;
  try {
    store = getCacheStore();
  } catch (e) {
    blobsAvailable = false;
  }

  // ── Try cache first ──
  if (blobsAvailable && !forceRefresh) {
    try {
      const cached = await store.get(CACHE_KEY, { type: "json" });
      if (cached && cached.fetchedAt) {
        const age = Date.now() - new Date(cached.fetchedAt).getTime();
        if (age < CACHE_TTL_MS) {
          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ ...cached, cached: true, cacheAgeMinutes: Math.round(age / 60000) })
          };
        }
      }
    } catch (e) {
      // Cache miss - continue
    }
  }

  // ── Fetch fresh data from IBKR ──
  try {
    // Sequential to avoid IBKR ErrorCode 1001 on concurrent requests
    const posReport = await fetchFlexReport(TOKEN, QUERY_ID);
    const optReport = await fetchFlexReport(TOKEN, OPTIONS_QUERY_ID);

    if (posReport.error) {
      if (blobsAvailable) {
        try {
          const stale = await store.get(CACHE_KEY, { type: "json" });
          if (stale && stale.fetchedAt) {
            return {
              statusCode: 200,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
              body: JSON.stringify({ ...stale, cached: true, stale: true, staleError: posReport.error })
            };
          }
        } catch (e) {}
      }
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: posReport.error, raw: posReport.raw })
      };
    }

    const allPositions = parseTags(posReport.xml, "OpenPosition").filter(p => p.symbol);
    // Separate stocks from options in the main positions query
    const positions = allPositions.filter(p => p.assetCategory !== "OPT");
    const optionsFromPositions = extractOptionsFromPositions(allPositions);

    let dividends = [];
    let optionPositions = [];
    let optionsError = null;
    let navHistory = [];

    if (optReport.xml) {
      const cashTx = parseTags(optReport.xml, "CashTransaction");
      dividends = cashTx.filter(t => t.type === "Dividends");

      const optPositions = parseTags(optReport.xml, "OpenPosition");
      const rawOpts = optPositions.filter(p => p.assetCategory === "OPT" || (p.putCall && p.putCall !== ""));
      optionPositions = rawOpts.map(p => ({
        ...p,
        underlyingSymbol: p.underlyingSymbol || p.symbol,
        _source: "optQuery"
      }));

      const equity = parseTags(optReport.xml, "EquitySummaryByReportDateInBase");
      navHistory = equity
        .filter(e => e.reportDate && e.total)
        .map(e => ({ date: e.reportDate, nav: parseFloat(e.total) }))
        .sort((a, b) => a.date.localeCompare(b.date));
    } else {
      optionsError = optReport.error;
      // FALLBACK: use options parsed from the main positions query
      optionPositions = optionsFromPositions;
    }

    // ── NAV accumulation: merge today's snapshot with historical cache ──
    // Even when the options query fails, we build a NAV snapshot from current positions
    // and accumulate it day by day in the cache so the Rendimiento chart fills over time.
    const todaySnapshot = buildNavSnapshot(allPositions);

    if (blobsAvailable) {
      try {
        const prevCache = await store.get(CACHE_KEY, { type: "json" });
        const prevNav = (prevCache && prevCache.navHistory) ? prevCache.navHistory : [];
        // Merge: keep all previous days + today (replace if same date)
        const navMap = {};
        prevNav.forEach(n => { navMap[n.date] = n; });
        navMap[todaySnapshot.date] = todaySnapshot;
        // Also merge any nav from optReport if available
        navHistory.forEach(n => { navMap[n.date] = n; });
        navHistory = Object.values(navMap).sort((a, b) => a.date.localeCompare(b.date));
      } catch (e) {
        // If no prev cache, just use what we have + today
        const navMap = {};
        navHistory.forEach(n => { navMap[n.date] = n; });
        navMap[todaySnapshot.date] = todaySnapshot;
        navHistory = Object.values(navMap).sort((a, b) => a.date.localeCompare(b.date));
      }
    } else {
      // No blobs: just add today to whatever came from optReport
      const navMap = {};
      navHistory.forEach(n => { navMap[n.date] = n; });
      navMap[todaySnapshot.date] = todaySnapshot;
      navHistory = Object.values(navMap).sort((a, b) => a.date.localeCompare(b.date));
    }

    const usdPos = allPositions.find(p => p.currency === "USD" && p.fxRateToBase);
    const usdToEur = usdPos ? parseFloat(usdPos.fxRateToBase) : 0.92;

    const result = {
      positions,
      dividends,
      optionPositions,
      optionsError,
      navHistory,
      usdToEur,
      count: allPositions.length,
      fetchedAt: new Date().toISOString()
    };

    if (blobsAvailable) {
      try {
        await store.setJSON(CACHE_KEY, result);
      } catch (e) {}
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        ...result,
        cached: false,
        blobsAvailable,
        debug: positions.length === 0 ? posReport.xml.slice(0, 2000) : undefined
      })
    };

  } catch (err) {
    if (blobsAvailable) {
      try {
        const stale = await store.get(CACHE_KEY, { type: "json" });
        if (stale && stale.fetchedAt) {
          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ ...stale, cached: true, stale: true, staleError: err.message })
          };
        }
      } catch (e) {}
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message, step: "exception" })
    };
  }
};
