/**
 * portfolio.js — Netlify Serverless Function
 * Obtiene datos de cartera desde IBKR Flex Query API y los sirve al dashboard.
 *
 * Arquitectura:
 *   1. Intenta servir desde caché (Netlify Blobs, TTL 6h)
 *   2. Si caché expirada o force=1, lanza dos queries IBKR secuenciales
 *   3. Si el query de opciones falla, hace fallback a los OPTs del query principal
 *   4. Acumula historial NAV día a día en el caché (para el gráfico de Rendimiento)
 *   5. Si todo falla, sirve caché obsoleta marcada como stale
 */

"use strict";

const { getStore } = require("@netlify/blobs");

// ─── Constantes ────────────────────────────────────────────────────────────────

const CACHE_KEY     = "portfolio-cache";
const CACHE_TTL_MS  = 6 * 60 * 60 * 1000;   // 6 horas
const IBKR_BASE_URL = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";

// Reintentos para GetStatement: espera inicial 3s, backoff x1.5, máx 10 intentos → ~45s total
const POLL_INITIAL_DELAY_MS = 3_000;
const POLL_BACKOFF_FACTOR    = 1.5;
const POLL_MAX_ATTEMPTS      = 10;

// Regex que identifica respuestas de "aún no disponible" (no son errores definitivos)
const IBKR_RETRY_RE = /not yet available|generation in progress|try again|could not be generated/i;

// Meses en español para formatear fechas de expiración
const MONTHS_ES = ["ENE","FEB","MAR","ABR","MAY","JUN","JUL","AGO","SEP","OCT","NOV","DIC"];

// Cabeceras CORS/JSON reutilizables
const HEADERS_JSON = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};
const HEADERS_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Devuelve una Promise que se resuelve tras `ms` milisegundos. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Respuesta JSON estándar. */
const jsonResponse = (body, statusCode = 200) => ({
  statusCode,
  headers: HEADERS_JSON,
  body: JSON.stringify(body),
});

/**
 * Obtiene (o crea) el store de Netlify Blobs.
 * Lanza si las variables de entorno no están disponibles.
 */
function getCacheStore() {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  return siteID && token
    ? getStore({ name: "portfolio-data", siteID, token })
    : getStore("portfolio-data");
}

/**
 * Intenta leer la caché; devuelve null si no existe o lanza.
 * Nunca propaga excepciones: un fallo de caché nunca debe bloquear la respuesta.
 */
async function readCache(store) {
  try {
    return await store.get(CACHE_KEY, { type: "json" });
  } catch {
    return null;
  }
}

/** Guarda en caché de forma best-effort (nunca propaga errores). */
async function writeCache(store, data) {
  try {
    await store.setJSON(CACHE_KEY, data);
  } catch { /* ignorado */ }
}

// ─── Parser XML ────────────────────────────────────────────────────────────────

/**
 * Parser XML basado en regex, tolerante a atributos multilínea y self-closing tags.
 *
 * Limitaciones conocidas (aceptables para el XML de IBKR):
 *   - No soporta CDATA ni namespaces
 *   - Los valores de atributo no pueden contener comillas escapadas con \"
 *     (IBKR usa &quot; en su lugar, que sí se decodifica)
 *
 * Mejoras respecto al parser anterior:
 *   - Flag `s` (dotAll) para atributos multilínea
 *   - Decodificación de todas las entidades HTML estándar
 *   - No recrea el regex de atributos en cada iteración
 */
const ATTR_RE  = /(\w[\w.-]*)="([^"]*)"/gs;
const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = str =>
  str.replace(/&(\w+);/g, (_, e) => ENTITY_MAP[e] ?? `&${e};`);

function parseTags(xml, tagName) {
  const tagRe = new RegExp(`<${tagName}\\b([^>]*?)\\s*/?>`, "gs");
  const items  = [];
  let m;

  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = {};
    let a;
    // Reutilizamos ATTR_RE con lastIndex para evitar crear instancias nuevas
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(m[1])) !== null) {
      attrs[a[1]] = decodeEntities(a[2]);
    }
    items.push(attrs);
  }
  return items;
}

// ─── IBKR Flex Query ──────────────────────────────────────────────────────────

/**
 * Lanza un Flex Query y espera hasta obtener el XML resultante.
 *
 * Flujo IBKR:
 *   1. SendRequest → devuelve <ReferenceCode>
 *   2. GetStatement (polling) → devuelve XML o sigue "pending"
 *
 * Mejoras:
 *   - Backoff progresivo (3s → 4.5s → 6.75s …) para reducir carga en IBKR
 *   - Timeout explícito por intento (10s) para no quedarse colgado en red lenta
 *   - Mensajes de error más descriptivos
 *
 * @param {string} flexToken  Token de acceso IBKR
 * @param {string} queryId    ID del Flex Query
 * @returns {{ xml?: string, error?: string, raw?: string }}
 */
async function fetchFlexReport(flexToken, queryId) {
  // ── Paso 1: solicitar la generación del informe ──
  let reqText;
  try {
    const res = await fetch(
      `${IBKR_BASE_URL}.SendRequest?t=${flexToken}&q=${queryId}&v=3`,
      { signal: AbortSignal.timeout(15_000) }
    );
    reqText = await res.text();
  } catch (err) {
    return { error: `SendRequest falló (query ${queryId}): ${err.message}` };
  }

  const refMatch = reqText.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/s);
  if (!refMatch) {
    const errMsg = reqText.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/s)?.[1];
    return {
      error: errMsg ?? `SendRequest sin ReferenceCode (query ${queryId})`,
      raw: reqText.slice(0, 800),
    };
  }
  const refCode = refMatch[1].trim();

  // ── Paso 2: polling con backoff progresivo ──
  let delay = POLL_INITIAL_DELAY_MS;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay);
    delay = Math.round(delay * POLL_BACKOFF_FACTOR);

    let text;
    try {
      const res = await fetch(
        `${IBKR_BASE_URL}.GetStatement?q=${refCode}&t=${flexToken}&v=3`,
        { signal: AbortSignal.timeout(15_000) }
      );
      text = await res.text();
    } catch (err) {
      // Error de red puntual → reintentar
      continue;
    }

    if (!text.includes("<ErrorMessage>")) {
      // Respuesta limpia → éxito
      return { xml: text };
    }

    const errMsg = text.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/s)?.[1] ?? "Error desconocido";

    if (IBKR_RETRY_RE.test(errMsg)) {
      // Informe aún en generación → seguir esperando
      continue;
    }

    // Error definitivo de IBKR (p.ej. query inválida, permisos, etc.)
    return { error: errMsg, raw: text.slice(0, 800) };
  }

  return {
    error: `IBKR no generó el informe tras ${POLL_MAX_ATTEMPTS} intentos (query ${queryId}).`,
  };
}

// ─── Parser de símbolos de opciones ──────────────────────────────────────────

/**
 * Parsea el símbolo de una opción en formato IBKR y devuelve sus componentes.
 *
 * Formatos soportados:
 *
 *   US estándar (OCC):
 *     "AVGO  270115P00360000"
 *     "BRK B 270115C00400000"   ← ticker con espacio (BRK B = BRK.B)
 *     "BF B  270115P00050000"
 *
 *   HK / Asia:
 *     "TCH DEC26 550 C"
 *     "700 DEC26 400 P"
 *
 *   Futuros (reconocidos pero sin put/call):
 *     "ESZ5"  (no se parsea como opción, se devuelve vacío)
 *
 * @param {string} sym  Símbolo raw de IBKR
 * @returns {{ underlying?: string, expiry?: string, strike?: number, putCall?: string }}
 */
function parseOptionSymbol(sym) {
  if (!sym) return {};
  const s = sym.trim();

  // ── Formato OCC estándar ──────────────────────────────────────────────────
  // El ticker puede tener hasta 6 caracteres (incluyendo espacio, p.ej. "BRK B")
  // Estructura: TTTTTT YYMMDD [P|C] SSSSSSSS
  //   TTTTTT  = ticker (1-6 chars, puede incluir espacio para tickers tipo BRK.B)
  //   YYMMDD  = fecha de expiración
  //   P|C     = tipo
  //   SSSSSSSS = strike × 1000, 8 dígitos con ceros a la izquierda
  const occRe = /^(.{1,6}?)\s{1,2}(\d{6})([PC])(\d{8})$/;
  const occM  = s.match(occRe);
  if (occM) {
    const [, rawTicker, dateStr, pc, strikePad] = occM;
    // Normalizar ticker: "BRK B" → "BRK.B", trim espacios sobrantes
    const underlying = rawTicker.trim().replace(/\s+/, ".");
    const mm     = parseInt(dateStr.slice(2, 4), 10);
    const dd     = dateStr.slice(4, 6);
    const yy     = dateStr.slice(0, 2);
    const strike = parseInt(strikePad, 10) / 1000;
    const expiry = `${dd} ${MONTHS_ES[mm - 1] ?? "???"} 20${yy}`;
    return { underlying, expiry, strike, putCall: pc };
  }

  // ── Formato HK / Asia ────────────────────────────────────────────────────
  // Ejemplo: "TCH DEC26 550 C"  o  "700 MAR27 420.5 P"
  const hkRe = /^([\w.]+)\s+([A-Z]{3}\d{2})\s+([\d.]+)\s+([PC])$/i;
  const hkM  = s.match(hkRe);
  if (hkM) {
    const [, underlying, expiry, strikeStr, pc] = hkM;
    const strike = parseFloat(strikeStr);
    return {
      underlying: underlying.toUpperCase(),
      expiry: expiry.toUpperCase(),
      strike: isFinite(strike) ? strike : 0,
      putCall: pc.toUpperCase(),
    };
  }

  // ── Formato no reconocido (futuro, warrant, etc.) ─────────────────────────
  return { underlying: s };
}

// ─── Extracción de datos ──────────────────────────────────────────────────────

/**
 * Extrae y enriquece las posiciones de opciones desde el array de posiciones completo.
 * Se usa cuando el query de opciones dedicado falla (fallback).
 */
function extractOptionsFromPositions(allPositions) {
  return allPositions
    .filter(p => p.assetCategory === "OPT")
    .map(p => {
      const parsed = parseOptionSymbol(p.symbol);
      return {
        ...p,
        underlyingSymbol : parsed.underlying ?? p.symbol,
        expiry           : parsed.expiry     ?? "",
        strike           : parsed.strike     ?? 0,
        putCall          : parsed.putCall    ?? "",
        _source          : "positions_fallback",
      };
    });
}

/**
 * Construye un snapshot NAV del día actual a partir de las posiciones.
 *
 * Usa fxRateToBase de cada posición si está disponible (más preciso que
 * los tipos fijos que teníamos antes). Solo si falta el campo usa un
 * fallback de emergencia para no devolver NaN.
 *
 * @param {object[]} allPositions  Array de posiciones (STK, FUND, OPT…)
 * @returns {{ date: string, nav: number }}
 */
function buildNavSnapshot(allPositions) {
  // Tipos de cambio de emergencia (solo se usan si IBKR no envía fxRateToBase)
  const FX_FALLBACK = { USD: 1, EUR: 1.09, HKD: 0.128, GBP: 1.27 };

  const nav = allPositions
    .filter(p => p.assetCategory === "STK" || p.assetCategory === "FUND")
    .reduce((sum, p) => {
      // fxRateToBase: cuántos USD vale 1 unidad de la divisa de la posición
      const fxRaw  = parseFloat(p.fxRateToBase);
      const fx     = isFinite(fxRaw) && fxRaw > 0
        ? fxRaw
        : (FX_FALLBACK[p.currency] ?? 1);
      const posVal = parseFloat(p.positionValue);
      return sum + (isFinite(posVal) ? posVal * fx : 0);
    }, 0);

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return { date: today, nav: Math.round(nav) };
}

/**
 * Combina el historial NAV previo (del caché) con los datos nuevos,
 * dando prioridad a los datos de IBKR cuando hay solapamiento de fechas.
 *
 * @param {object[]} prevNav     Historial anterior { date, nav }[]
 * @param {object[]} freshNav    Datos nuevos de EquitySummaryByReportDateInBase
 * @param {object}   todaySnap  Snapshot calculado hoy desde posiciones
 * @returns {object[]} Array ordenado por fecha ascendente
 */
function mergeNavHistory(prevNav, freshNav, todaySnap) {
  // Empezamos con el historial previo
  const map = Object.fromEntries((prevNav ?? []).map(n => [n.date, n]));
  // Los datos frescos de IBKR sobreescriben (más fiables)
  for (const n of (freshNav ?? [])) {
    if (n.date && isFinite(n.nav)) map[n.date] = n;
  }
  // El snapshot de hoy siempre se añade (incluso sin EquitySummary)
  if (todaySnap.date && isFinite(todaySnap.nav) && todaySnap.nav > 0) {
    map[todaySnap.date] = todaySnap;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Handler principal ────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: HEADERS_CORS, body: "" };
  }

  // ── Variables de entorno ──
  const TOKEN            = process.env.IBKR_FLEX_TOKEN;
  const QUERY_ID         = process.env.IBKR_QUERY_ID         ?? "1541787";
  const OPTIONS_QUERY_ID = process.env.IBKR_OPTIONS_QUERY_ID ?? "1495741";
  const forceRefresh     = event.queryStringParameters?.force === "1";

  if (!TOKEN) {
    return jsonResponse(
      { error: "IBKR_FLEX_TOKEN no configurado en Netlify Environment Variables" },
      500
    );
  }

  // ── Caché ──
  let store         = null;
  let blobsAvailable = false;
  try {
    store          = getCacheStore();
    blobsAvailable = true;
  } catch { /* Blobs no disponibles en este entorno */ }

  if (blobsAvailable && !forceRefresh) {
    const cached = await readCache(store);
    if (cached?.fetchedAt) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return jsonResponse({
          ...cached,
          cached: true,
          cacheAgeMinutes: Math.round(age / 60_000),
        });
      }
    }
  }

  // ── Fetch desde IBKR ──
  // IMPORTANTE: las peticiones deben ser secuenciales.
  // IBKR devuelve ErrorCode 1001 si recibe dos SendRequest simultáneos con el mismo token.
  let posReport, optReport;
  try {
    posReport = await fetchFlexReport(TOKEN, QUERY_ID);
    optReport = await fetchFlexReport(TOKEN, OPTIONS_QUERY_ID);
  } catch (err) {
    // Error de red catastrófico (no debería llegar aquí, fetchFlexReport lo atrapa)
    const stale = blobsAvailable ? await readCache(store) : null;
    if (stale?.fetchedAt) {
      return jsonResponse({ ...stale, cached: true, stale: true, staleError: err.message });
    }
    return jsonResponse({ error: `Error inesperado: ${err.message}`, step: "fetch" });
  }

  // Si el query principal falla → intentar caché obsoleta o devolver error
  if (posReport.error) {
    const stale = blobsAvailable ? await readCache(store) : null;
    if (stale?.fetchedAt) {
      return jsonResponse({ ...stale, cached: true, stale: true, staleError: posReport.error });
    }
    return jsonResponse({ error: posReport.error, raw: posReport.raw });
  }

  // ── Parseo de posiciones ──
  const allPositions = parseTags(posReport.xml, "OpenPosition")
    .filter(p => p.symbol); // descartar filas vacías

  const positions          = allPositions.filter(p => p.assetCategory !== "OPT");
  const optionsFromMain    = extractOptionsFromPositions(allPositions);

  // ── Parseo del query de opciones (con fallback) ──
  let dividends      = [];
  let optionPositions = [];
  let optionsError   = null;
  let freshNavHistory = [];

  if (optReport.xml) {
    // ── Query de opciones OK ──
    dividends = parseTags(optReport.xml, "CashTransaction")
      .filter(t => t.type === "Dividends");

    // Enriquecer opciones del query dedicado con datos parseados
    optionPositions = parseTags(optReport.xml, "OpenPosition")
      .filter(p => p.assetCategory === "OPT" || p.putCall)
      .map(p => {
        // El query de opciones normalmente ya tiene underlyingSymbol, strike, putCall
        // como atributos XML; sólo parseamos el símbolo si falta alguno
        if (p.underlyingSymbol && p.strike && p.putCall) {
          return { ...p, _source: "optQuery" };
        }
        const parsed = parseOptionSymbol(p.symbol);
        return {
          ...p,
          underlyingSymbol : p.underlyingSymbol ?? parsed.underlying ?? p.symbol,
          strike           : parseFloat(p.strike) || parsed.strike    || 0,
          putCall          : p.putCall            ?? parsed.putCall   ?? "",
          expiry           : p.expiry             ?? parsed.expiry    ?? "",
          _source          : "optQuery",
        };
      });

    // Historial NAV desde EquitySummaryByReportDateInBase
    freshNavHistory = parseTags(optReport.xml, "EquitySummaryByReportDateInBase")
      .filter(e => e.reportDate && e.total)
      .map(e => {
        const nav = parseFloat(e.total);
        return isFinite(nav) ? { date: e.reportDate, nav } : null;
      })
      .filter(Boolean);

  } else {
    // ── Fallback: opciones del query principal ──
    optionsError    = optReport.error;
    optionPositions = optionsFromMain;
  }

  // ── NAV: snapshot de hoy + merge con historial previo ──
  const todaySnapshot = buildNavSnapshot(allPositions);
  const prevCache     = blobsAvailable ? await readCache(store) : null;
  const navHistory    = mergeNavHistory(
    prevCache?.navHistory ?? [],
    freshNavHistory,
    todaySnapshot
  );

  // ── Tipo de cambio USD→EUR ──
  // Usamos el fxRateToBase de cualquier posición USD (todos tienen el mismo valor)
  const usdFx    = allPositions.find(p => p.currency === "USD" && p.fxRateToBase);
  const usdToEur = parseFloat(usdFx?.fxRateToBase) || 0.92;

  // ── Construir resultado ──
  const result = {
    positions,
    dividends,
    optionPositions,
    optionsError,
    navHistory,
    usdToEur,
    count     : allPositions.length,
    fetchedAt : new Date().toISOString(),
  };

  if (blobsAvailable) await writeCache(store, result);

  return jsonResponse({
    ...result,
    cached        : false,
    blobsAvailable,
    // Solo en modo debug (0 posiciones) incluimos el XML crudo para diagnóstico
    debug: positions.length === 0 ? posReport.xml?.slice(0, 2000) : undefined,
  });
};
