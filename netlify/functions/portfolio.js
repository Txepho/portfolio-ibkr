// Netlify function: fetches IBKR Flex Query reports (positions + dividends/options)
// Caches results using Netlify Blobs to avoid hitting IBKR's per-token rate limit.

const { getStore } = require("@netlify/blobs");

const CACHE_KEY = "portfolio-cache";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getCacheStore() {
  // Explicit credentials needed because automatic context injection
  // is not always available depending on deploy/build setup.
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (siteID && token) {
    return getStore({ name: "portfolio-data", siteID, token });
  }
  // Fallback to automatic context (works in some deploy contexts)
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
      // Cache miss, error reading cache, or blobs not available - continue to fetch fresh data
    }
  }

  // ── Fetch fresh data from IBKR ──
  try {
    const [posReport, optReport] = await Promise.all([
      fetchFlexReport(TOKEN, QUERY_ID),
      fetchFlexReport(TOKEN, OPTIONS_QUERY_ID)
    ]);

    if (posReport.error) {
      // If we have stale cache, serve it instead of failing completely
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

    const positions = parseTags(posReport.xml, "OpenPosition").filter(p => p.symbol);

    let dividends = [];
    let optionPositions = [];
    let optionsError = null;

    if (optReport.xml) {
      const cashTx = parseTags(optReport.xml, "CashTransaction");
      dividends = cashTx.filter(t => t.type === "Dividends");
      const optPositions = parseTags(optReport.xml, "OpenPosition");
      optionPositions = optPositions.filter(p => p.assetCategory === "OPT" || (p.putCall && p.putCall !== ""));
    } else {
      optionsError = optReport.error;
    }

    const result = {
      positions,
      dividends,
      optionPositions,
      optionsError,
      count: positions.length,
      fetchedAt: new Date().toISOString()
    };

    // Save to cache (best-effort, don't fail the response if this fails)
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
    // Try to serve stale cache on unexpected errors too
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
