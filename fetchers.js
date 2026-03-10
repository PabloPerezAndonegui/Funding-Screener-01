'use strict';

const fetch = require('node-fetch');

const FETCH_TIMEOUT = 12000;

// ─── Symbol normalization ──────────────────────────────────────────────────────

function normalizeSymbol(s) {
  return s
    .replace(/-USDT$|-USD$|-PERP$/i, '')
    .replace(/USDT$|USD$/i, '')
    .toUpperCase()
    .trim();
}

// ─── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Exchange fetchers ─────────────────────────────────────────────────────────

async function fetchHyperliquid() {
  const data = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const [meta, ctxs] = data;
  const result = {};
  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx || ctx.funding == null) return;
    if (parseFloat(ctx.openInterest) === 0 || ctx.midPx == null) return; // dead market
    result[normalizeSymbol(asset.name)] = parseFloat(ctx.funding) * 8;
  });
  return result;
}

async function fetchVariational() {
  const data = await fetchWithTimeout(
    'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats'
  );
  const result = {};
  (data.listings || []).forEach((listing) => {
    if (listing.funding_rate == null) return;
    const oi = listing.open_interest;
    if (!oi || (parseFloat(oi.long_open_interest) === 0 && parseFloat(oi.short_open_interest) === 0)) return; // dead market
    const rateDecimal = parseFloat(listing.funding_rate);
    if (!isFinite(rateDecimal)) return;
    result[normalizeSymbol(listing.ticker)] = rateDecimal / 1095;
  });
  return result;
}

async function fetchAster() {
  const [premiumIndex, fundingInfo] = await Promise.all([
    fetchWithTimeout('https://fapi.asterdex.com/fapi/v1/premiumIndex'),
    fetchWithTimeout('https://fapi.asterdex.com/fapi/v1/fundingInfo'),
  ]);
  const intervalMap = {};
  (Array.isArray(fundingInfo) ? fundingInfo : []).forEach((item) => {
    intervalMap[item.symbol] = item.fundingIntervalHours || 8;
  });
  const result = {};
  const fromUSDT = {};
  (Array.isArray(premiumIndex) ? premiumIndex : []).forEach((item) => {
    if (item.lastFundingRate == null) return;
    if (!item.markPrice || parseFloat(item.markPrice) === 0) return; // dead market (no bulk OI available)
    const rate = parseFloat(item.lastFundingRate);
    if (!isFinite(rate)) return;
    const sym = normalizeSymbol(item.symbol);
    const isUSDT = item.symbol.endsWith('USDT');
    const intervalHours = intervalMap[item.symbol] || 8;
    const rate8h = rate * (8 / intervalHours);
    if (!(sym in result) || (isUSDT && !fromUSDT[sym])) {
      result[sym] = rate8h;
      fromUSDT[sym] = isUSDT;
    }
  });
  return result;
}

// 01Exchange: per-process market list cache
let marketCache     = null;
let marketCacheTime = 0;
const MARKET_CACHE_TTL = 5 * 60 * 1000;

async function get01Markets() {
  if (marketCache && Date.now() - marketCacheTime < MARKET_CACHE_TTL) return marketCache;
  const info = await fetchWithTimeout('https://zo-mainnet.n1.xyz/info');
  marketCache     = info.markets || [];
  marketCacheTime = Date.now();
  return marketCache;
}

async function fetch01Exchange() {
  const markets = await get01Markets();
  const results = await Promise.allSettled(
    markets.map(async (m) => {
      const stats = await fetchWithTimeout(`https://zo-mainnet.n1.xyz/market/${m.marketId}/stats`);
      if (!stats.perpStats || stats.perpStats.funding_rate == null) return null;
      if (stats.perpStats.open_interest == null || stats.perpStats.open_interest === 0) return null; // dead market
      return { symbol: normalizeSymbol(m.symbol), rate8h: stats.perpStats.funding_rate * 8 };
    })
  );
  const result = {};
  results.forEach((r) => {
    if (r.status === 'fulfilled' && r.value) result[r.value.symbol] = r.value.rate8h;
  });
  return result;
}

// ─── Fetch all exchanges concurrently ─────────────────────────────────────────
// Returns { exchangeKey → { symbol → rate8h } }
// Failed exchanges silently return {} so callers always get a complete object.

async function fetchAllRates() {
  const fetchers = {
    hyperliquid:  fetchHyperliquid,
    variational:  fetchVariational,
    aster:        fetchAster,
    '01exchange': fetch01Exchange,
  };
  const names   = Object.keys(fetchers);
  const results = await Promise.allSettled(names.map(n => fetchers[n]()));
  const out = {};
  names.forEach((n, i) => {
    out[n] = results[i].status === 'fulfilled' ? results[i].value : {};
  });
  return out;
}

module.exports = {
  normalizeSymbol,
  fetchWithTimeout,
  fetchHyperliquid,
  fetchVariational,
  fetchAster,
  fetch01Exchange,
  fetchAllRates,
};
