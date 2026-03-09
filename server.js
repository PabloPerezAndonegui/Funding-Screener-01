const express = require('express');
const path    = require('path');
const {
  fetchHyperliquid,
  fetchVariational,
  fetchAster,
  fetch01Exchange,
} = require('./fetchers');

const app  = express();
const PORT = process.env.PORT || 3000;
const STALE_ERROR_MS = 5 * 60 * 1000; // 5 min continuous failure → red/error status

app.use(express.static(path.join(__dirname, 'public')));

// ─── Per-exchange cache ────────────────────────────────────────────────────────
// Keeps last successful data so failures return stale data instead of empty.
// Only marks an exchange as 'error' after 5+ minutes of continuous failure.

const exchangeCache = {};
// Schema per key: { data, lastSuccess (ms), failingSince (ms) | null }

async function cachedFetch(name, fetcher) {
  if (!exchangeCache[name]) {
    exchangeCache[name] = { data: null, lastSuccess: null, failingSince: null };
  }
  const cache = exchangeCache[name];

  try {
    const data = await fetcher();
    cache.data        = data;
    cache.lastSuccess = Date.now();
    cache.failingSince = null;
    return { status: 'ok', data, lastSuccess: cache.lastSuccess };
  } catch (err) {
    if (!cache.failingSince) cache.failingSince = Date.now();
    const failDuration = Date.now() - cache.failingSince;
    const hasData      = cache.data !== null;

    if (hasData && failDuration < STALE_ERROR_MS) {
      return {
        status: 'stale',
        data: cache.data,
        lastSuccess: cache.lastSuccess,
        error: err.message,
      };
    } else {
      return {
        status: 'error',
        data: cache.data || {},
        lastSuccess: cache.lastSuccess,
        error: err.message,
      };
    }
  }
}

// ─── Main API endpoint ─────────────────────────────────────────────────────────

app.get('/api/rates', async (req, res) => {
  const fetchers = {
    hyperliquid:  fetchHyperliquid,
    variational:  fetchVariational,
    aster:        fetchAster,
    '01exchange': fetch01Exchange,
  };

  const names   = Object.keys(fetchers);
  const results = await Promise.allSettled(
    names.map(name => cachedFetch(name, fetchers[name]))
  );

  const exchanges = {};
  names.forEach((name, i) => {
    const r = results[i];
    exchanges[name] = r.status === 'fulfilled'
      ? r.value
      : { status: 'error', data: exchangeCache[name]?.data || {}, lastSuccess: exchangeCache[name]?.lastSuccess || null, error: r.reason?.message };
  });

  res.json({ timestamp: new Date().toISOString(), exchanges });
});

app.listen(PORT, () => {
  console.log(`\n  Funding Screener running at http://localhost:${PORT}\n`);
});
