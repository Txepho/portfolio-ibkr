/**
 * refresh-background.js — Netlify Background Function
 *
 * Se invoca con POST desde portfolio.js cuando el caché está obsoleto.
 * Al ser Background Function tiene 15 minutos de timeout (vs 26s normal).
 * Actualiza el caché en Netlify Blobs sin que el usuario espere.
 *
 * URL: /.netlify/functions/refresh-background
 * Las Background Functions siempre devuelven 202 inmediatamente;
 * el trabajo real ocurre en segundo plano.
 */

"use strict";

const { getStore } = require("@netlify/blobs");

const CACHE_KEY     = "portfolio-cache";
const IBKR_BASE_URL = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";

// Con 15 min disponibles podemos ser generosos: 5s inicial, x1.5, máx 12 intentos → ~2 min
const POLL_INITIAL_DELAY_MS = 5_000;
const POLL_BACKOFF_FACTOR    = 1.5;
const POLL_MAX_ATTEMPTS      = 12;
const IBKR_RETRY_RE = /not yet available|generation in progress|try again|could not be generated/i;
const MONTHS_ES     = ["ENE","FEB","MAR","ABR","MAY","JUN","JUL","AGO","SEP","OCT","NOV","DIC"];

// ─── Helpers (duplicados de portfolio.js — sin módulos compartidos en Netlify) ─

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getCacheStore() {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  return siteID && token
    ? getStore({ name: "portfolio-data", siteID, token })
    : getStore("portfolio-data");
}

async function readCache(store) {
  try { return await store.get(CACHE_KEY, { type: "json" }); } catch { return null; }
}

async function writeCache(store, data) {
  try { await store.setJSON(CACHE_KEY, data); } catch { /* ignorado */ }
}

const ATTR_RE    = /(\w[\w.-]*)="([^"]*)"/gs;
const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = str => str.replace(/&(\w+);/g, (_, e) => ENTITY_MAP[e] ?? `&${e};`);

function parseTags(xml, tagName) {
  const tagRe = new RegExp(`<${tagName}\\b([^>]*?)\\s*/?>`, "gs");
  const items = [];
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = {};
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(m[1])) !== null) attrs[a[1]] = decodeEntities(a[2]);
    items.push(attrs);
  }
  return items;
}

async function fetchFlexReport(flexToken, queryId) {
  let reqText;
  try {
    const res = await fetch(
      `${IBKR_BASE_URL}.SendRequest?t=${flexToken}&q=${queryId}&v=3`,
      { signal: AbortSignal.timeout(20_000) }
    );
    reqText = await res.text();
  } catch (err) {
    return { error: `SendRequest falló (query ${queryId}): ${err.message}` };
  }

  const refMatch = reqText.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/s);
  if (!refMatch) {
    const errMsg = reqText.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/s)?.[1];
    return { error: errMsg ?? `SendRequest sin ReferenceCode (query ${queryId})`, raw: reqText.slice(0, 800) };
  }
  const refCode = refMatch[1].trim();

  let delay = POLL_INITIAL_DELAY_MS;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay);
    delay = Math.round(delay * POLL_BACKOFF_FACTOR);

    let text;
    try {
      const res = await fetch(
        `${IBKR_BASE_URL}.GetStatement?q=${refCode}&t=${flexToken}&v=3`,
        { signal: AbortSignal.timeout(20_000) }
      );
      text = await res.text();
    } catch { continue; }

    if (!text.includes("<ErrorMessage>")) return { xml: text };

    const errMsg = text.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/s)?.[1] ?? "Error desconocido";
    if (IBKR_RETRY_RE.test(errMsg)) continue;
    return { error: errMsg, raw: text.slice(0, 800) };
  }
  return { error: `IBKR no generó el informe tras ${POLL_MAX_ATTEMPTS} intentos (query ${queryId}).` };
}

function parseOptionSymbol(sym) {
  if (!sym) return {};
  const s = sym.trim();
  const occM = s.match(/^(.{1,6}?)\s{1,2}(\d{6})([PC])(\d{8})$/);
  if (occM) {
    const [, rawTicker, dateStr, pc, strikePad] = occM;
    const mm = parseInt(dateStr.slice(2, 4), 10);
    return {
      underlying: rawTicker.trim().replace(/\s+/, "."),
      expiry: `${dateStr.slice(4, 6)} ${MONTHS_ES[mm - 1] ?? "???"} 20${dateStr.slice(0, 2)}`,
      strike: parseInt(strikePad, 10) / 1000,
      putCall: pc,
    };
  }
  const hkM = s.match(/^([\w.]+)\s+([A-Z]{3}\d{2})\s+([\d.]+)\s+([PC])$/i);
  if (hkM) {
    const strike = parseFloat(hkM[3]);
    return {
      underlying: hkM[1].toUpperCase(),
      expiry: hkM[2].toUpperCase(),
      strike: isFinite(strike) ? strike : 0,
      putCall: hkM[4].toUpperCase(),
    };
  }
  return { underlying: s };
}

function extractOptionsFromPositions(allPositions) {
  return allPositions
    .filter(p => p.assetCategory === "OPT")
    .map(p => {
      const parsed = parseOptionSymbol(p.symbol);
      return {
        ...p,
        underlyingSymbol: parsed.underlying ?? p.symbol,
        expiry:           parsed.expiry     ?? "",
        strike:           parsed.strike     ?? 0,
        putCall:          parsed.putCall    ?? "",
        _source:          "positions_fallback",
      };
    });
}

function buildNavSnapshot(allPositions) {
  const FX_FALLBACK = { USD: 1, EUR: 1.09, HKD: 0.128, GBP: 1.27 };
  const nav = allPositions
    .filter(p => p.assetCategory === "STK" || p.assetCategory === "FUND")
    .reduce((sum, p) => {
      const fxRaw = parseFloat(p.fxRateToBase);
      const fx    = isFinite(fxRaw) && fxRaw > 0 ? fxRaw : (FX_FALLBACK[p.currency] ?? 1);
      const val   = parseFloat(p.positionValue);
      return sum + (isFinite(val) ? val * fx : 0);
    }, 0);
  return { date: new Date().toISOString().slice(0, 10).replace(/-/g, ""), nav: Math.round(nav) };
}

function mergeNavHistory(prevNav, freshNav, todaySnap) {
  const map = Object.fromEntries((prevNav ?? []).map(n => [n.date, n]));
  for (const n of (freshNav ?? [])) {
    if (n.date && isFinite(n.nav)) map[n.date] = n;
  }
  if (todaySnap.date && isFinite(todaySnap.nav) && todaySnap.nav > 0) {
    map[todaySnap.date] = todaySnap;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async () => {
  const TOKEN            = process.env.IBKR_FLEX_TOKEN;
  const QUERY_ID         = process.env.IBKR_QUERY_ID         ?? "1541787";
  const OPTIONS_QUERY_ID = process.env.IBKR_OPTIONS_QUERY_ID ?? "1495741";

  if (!TOKEN) return; // Sin token no hay nada que hacer

  let store;
  try { store = getCacheStore(); } catch { return; }

  // Queries secuenciales para evitar ErrorCode 1001 de IBKR
  const posReport = await fetchFlexReport(TOKEN, QUERY_ID);
  if (posReport.error) return; // Query principal falló → no actualizar caché

  const optReport = await fetchFlexReport(TOKEN, OPTIONS_QUERY_ID);

  const allPositions = parseTags(posReport.xml, "OpenPosition").filter(p => p.symbol);
  const positions    = allPositions.filter(p => p.assetCategory !== "OPT");

  let dividends       = [];
  let optionPositions = [];
  let optionsError    = null;
  let freshNavHistory = [];

  if (optReport.xml) {
    dividends = parseTags(optReport.xml, "CashTransaction").filter(t => t.type === "Dividends");

    optionPositions = parseTags(optReport.xml, "OpenPosition")
      .filter(p => p.assetCategory === "OPT" || p.putCall)
      .map(p => {
        if (p.underlyingSymbol && p.strike && p.putCall) return { ...p, _source: "optQuery" };
        const parsed = parseOptionSymbol(p.symbol);
        return {
          ...p,
          underlyingSymbol: p.underlyingSymbol ?? parsed.underlying ?? p.symbol,
          strike:           parseFloat(p.strike) || parsed.strike   || 0,
          putCall:          p.putCall            ?? parsed.putCall  ?? "",
          expiry:           p.expiry             ?? parsed.expiry   ?? "",
          _source:          "optQuery",
        };
      });

    freshNavHistory = parseTags(optReport.xml, "EquitySummaryByReportDateInBase")
      .filter(e => e.reportDate && e.total)
      .map(e => { const nav = parseFloat(e.total); return isFinite(nav) ? { date: e.reportDate, nav } : null; })
      .filter(Boolean);
  } else {
    optionsError    = optReport.error;
    optionPositions = extractOptionsFromPositions(allPositions);
  }

  const todaySnap  = buildNavSnapshot(allPositions);
  const prevCache  = await readCache(store);
  const navHistory = mergeNavHistory(prevCache?.navHistory ?? [], freshNavHistory, todaySnap);

  const usdFx    = allPositions.find(p => p.currency === "USD" && p.fxRateToBase);
  const usdToEur = parseFloat(usdFx?.fxRateToBase) || 0.92;

  await writeCache(store, {
    positions, dividends, optionPositions,
    optionsError, navHistory, usdToEur,
    count: allPositions.length,
    fetchedAt: new Date().toISOString(),
  });
};
