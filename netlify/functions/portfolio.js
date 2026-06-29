/**
 * portfolio.js — Netlify Serverless Function (solo lectura)
 *
 * Arquitectura split:
 *   - portfolio.js       → lee caché, responde en <100ms siempre
 *   - refresh-background.js → actualiza caché desde IBKR (15 min timeout)
 *
 * Cuando el caché está obsoleto o force=1:
 *   1. Sirve el caché actual (aunque sea stale) para respuesta inmediata
 *   2. Dispara refresh-background en segundo plano
 *   3. El frontend reintenta automáticamente tras unos segundos
 */

"use strict";

const { getStore } = require("@netlify/blobs");

const CACHE_KEY    = "portfolio-cache";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

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

const jsonResponse = (body, statusCode = 200) => ({
  statusCode,
  headers: HEADERS_JSON,
  body: JSON.stringify(body),
});

// Dispara la Background Function sin esperar respuesta
async function triggerRefresh(event) {
  try {
    const host  = event.headers?.host ?? "";
    const proto = host.includes("localhost") ? "http" : "https";
    // fire-and-forget: no await
    fetch(`${proto}://${host}/.netlify/functions/refresh-background`, {
      method: "POST",
      signal: AbortSignal.timeout(3_000), // solo espera ACK inicial (202)
    }).catch(() => {}); // ignorar errores — es best-effort
  } catch { /* ignorado */ }
}

exports.handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: HEADERS_CORS, body: "" };
  }

  const forceRefresh = event.queryStringParameters?.force === "1";

  let store;
  let blobsAvailable = false;
  try {
    store          = getCacheStore();
    blobsAvailable = true;
  } catch { /* Blobs no disponibles */ }

  if (!blobsAvailable) {
    // Sin Blobs no hay caché ni background refresh — responder vacío con error claro
    return jsonResponse({
      error: "Netlify Blobs no disponible. Verifica NETLIFY_SITE_ID y NETLIFY_BLOBS_TOKEN.",
      positions: [], dividends: [], optionPositions: [],
      navHistory: [], usdToEur: 0.92, count: 0,
    });
  }

  const cached = await readCache(store);

  if (!forceRefresh && cached?.fetchedAt) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < CACHE_TTL_MS) {
      // Caché fresca → servir directamente
      return jsonResponse({ ...cached, cached: true, cacheAgeMinutes: Math.round(age / 60_000) });
    }
  }

  // Caché expirada o force=1 → disparar refresh en background
  await triggerRefresh(event);

  if (cached?.fetchedAt) {
    // Servir caché obsoleta mientras el background actualiza
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    return jsonResponse({
      ...cached,
      cached: true,
      stale: true,
      refreshing: true, // señal para el frontend: "actualización en curso"
      cacheAgeMinutes: Math.round(age / 60_000),
      staleMessage: "Actualizando datos desde IBKR en segundo plano. Reintenta en 60 segundos.",
    });
  }

  // Sin caché en absoluto (primera vez) → esperar un poco y devolver vacío
  return jsonResponse({
    positions: [], dividends: [], optionPositions: [],
    optionsError: null, navHistory: [], usdToEur: 0.92,
    count: 0, fetchedAt: null,
    refreshing: true,
    staleMessage: "Primera carga: obteniendo datos desde IBKR. Reintenta en 90 segundos.",
  });
};
