'use strict';

require('dotenv').config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN || TOKEN === 'your_token_here') {
  console.log('[Bot] TELEGRAM_BOT_TOKEN not configured in .env — bot is inactive.');
  // Keep the process alive so concurrently does not error out
  setInterval(() => {}, 60_000);
} else {
  startBot(TOKEN);
}

// ─────────────────────────────────────────────────────────────────────────────

function startBot(token) {
  const TelegramBot     = require('node-telegram-bot-api');
  const { fetchAllRates, normalizeSymbol } = require('./fetchers');

  const bot = new TelegramBot(token, { polling: true });

  // ── Constants ───────────────────────────────────────────────────────────────

  const EXCHANGES = ['01exchange', 'variational', 'aster', 'hyperliquid'];
  const EX_LABEL  = {
    '01exchange': '01Exchange',
    variational:  'Variational',
    aster:        'Aster',
    hyperliquid:  'Hyperliquid',
  };

  const POLL_INTERVAL_MS    = 60_000;  // how often to check rates
  const DROP_CHECKS         = 10;      // consecutive checks below threshold → alert
  const HIGH_ARB_THRESHOLD  = 200;     // BPS
  const HIGH_ARB_CHECKS     = 5;       // consecutive checks above threshold → alert

  // ── In-memory state ─────────────────────────────────────────────────────────

  // users: { chatId → { registered, alerts: [Alert] } }
  // Alert: { id, ex1, ex2, sym, thresholdBps, belowCount, alerted }
  const users = {};

  // addFlow: { chatId → { step (1-4), ex1?, ex2?, sym? } }
  const addFlow = {};

  // highArbTrackers: { 'ex1|ex2|sym' → { count, alerted } }
  const highArbTrackers = {};

  let alertIdCounter = 0;

  function getUser(chatId) {
    if (!users[chatId]) users[chatId] = { registered: false, alerts: [] };
    return users[chatId];
  }

  function fmtBps(rate8h) {
    return (rate8h * 10_000).toFixed(1);
  }

  // ── Keyboard helpers ─────────────────────────────────────────────────────────

  function exchangeKeyboard(exchanges) {
    // All exchange buttons in a single row
    return {
      inline_keyboard: [
        exchanges.map(ex => ({ text: EX_LABEL[ex], callback_data: `ex:${ex}` })),
      ],
    };
  }

  function alertRemoveKeyboard(alerts) {
    return {
      inline_keyboard: alerts.map(a => [{
        text: `${a.sym}  ${EX_LABEL[a.ex1]} ↔ ${EX_LABEL[a.ex2]}  (< ${a.thresholdBps} BPS)`,
        callback_data: `remove:${a.id}`,
      }]),
    };
  }

  // ── /start ──────────────────────────────────────────────────────────────────

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    getUser(chatId).registered = true;
    bot.sendMessage(chatId,
      `Welcome to Funding Screener Bot!\n\n` +
      `I monitor funding rate arbitrage across perp DEXes and alert you when opportunities appear or your positions need attention.\n\n` +
      `Commands:\n` +
      `/add — Set a new ARB alert for a trading pair\n` +
      `/list — View your active alerts with current ARB values\n` +
      `/remove — Delete an active alert\n` +
      `/status SYMBOL — Get current funding rates for any symbol (e.g. /status SOL)\n\n` +
      `You will also receive global alerts when any pair exceeds ${HIGH_ARB_THRESHOLD} BPS for ${HIGH_ARB_CHECKS}+ minutes.`
    );
  });

  // ── /add — kick off flow ─────────────────────────────────────────────────────

  bot.onText(/\/add/, (msg) => {
    const chatId = msg.chat.id;
    getUser(chatId); // ensure user exists
    addFlow[chatId] = { step: 1 };
    bot.sendMessage(chatId, 'Step 1: Select Exchange 1:', {
      reply_markup: exchangeKeyboard(EXCHANGES),
    });
  });

  // ── /list ───────────────────────────────────────────────────────────────────

  bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);

    if (user.alerts.length === 0) {
      bot.sendMessage(chatId, 'You have no active alerts. Use /add to create one.');
      return;
    }

    bot.sendMessage(chatId, 'Fetching current rates…');

    let rates;
    try { rates = await fetchAllRates(); }
    catch { rates = {}; }

    let text = 'Your active alerts:\n\n';
    user.alerts.forEach((alert, i) => {
      const r1  = rates[alert.ex1]?.[alert.sym];
      const r2  = rates[alert.ex2]?.[alert.sym];
      const arb = (r1 != null && r2 != null) ? Math.abs(r1 - r2) * 10_000 : null;
      const arbStr = arb != null ? `${arb.toFixed(1)} BPS` : 'N/A';
      text += `${i + 1}. ${alert.sym}  ${EX_LABEL[alert.ex1]} ↔ ${EX_LABEL[alert.ex2]}\n`;
      text += `   Threshold: < ${alert.thresholdBps} BPS  |  Current ARB: ${arbStr}\n\n`;
    });

    bot.sendMessage(chatId, text);
  });

  // ── /remove ─────────────────────────────────────────────────────────────────

  bot.onText(/\/remove/, (msg) => {
    const chatId = msg.chat.id;
    const user   = getUser(chatId);

    if (user.alerts.length === 0) {
      bot.sendMessage(chatId, 'You have no active alerts to remove.');
      return;
    }

    bot.sendMessage(chatId, 'Tap an alert to remove it:', {
      reply_markup: alertRemoveKeyboard(user.alerts),
    });
  });

  // ── /status SYMBOL ──────────────────────────────────────────────────────────

  bot.onText(/\/status(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const raw    = match[1]?.trim();

    if (!raw) {
      bot.sendMessage(chatId, 'Usage: /status SYMBOL  (e.g. /status SOL)');
      return;
    }

    const sym = normalizeSymbol(raw);
    bot.sendMessage(chatId, `Fetching rates for ${sym}…`);

    let rates;
    try { rates = await fetchAllRates(); }
    catch (err) {
      bot.sendMessage(chatId, `Error fetching rates: ${err.message}`);
      return;
    }

    const found = EXCHANGES
      .filter(ex => rates[ex]?.[sym] != null)
      .map(ex => ({ ex, rate: rates[ex][sym] }));

    if (found.length === 0) {
      bot.sendMessage(chatId, `Symbol "${sym}" not found on any exchange.`);
      return;
    }

    let text = `Funding rates for ${sym} (8h BPS):\n\n`;
    found.forEach(({ ex, rate }) => {
      text += `${EX_LABEL[ex]}: ${fmtBps(rate)} BPS\n`;
    });

    if (found.length >= 2) {
      const maxRate = Math.max(...found.map(f => f.rate));
      const minRate = Math.min(...found.map(f => f.rate));
      const maxEx   = found.find(f => f.rate === maxRate).ex;
      const minEx   = found.find(f => f.rate === minRate).ex;
      const arb     = (maxRate - minRate) * 10_000;
      text += `\nMax ARB: ${arb.toFixed(1)} BPS\n`;
      if (maxEx !== minEx) {
        text += `LONG ${EX_LABEL[minEx]}  /  SHORT ${EX_LABEL[maxEx]}`;
      }
    }

    bot.sendMessage(chatId, text);
  });

  // ── Callback queries (inline keyboards) ─────────────────────────────────────

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;

    // Exchange selection during /add flow
    if (data.startsWith('ex:')) {
      const ex   = data.slice(3);
      const flow = addFlow[chatId];

      if (!flow) {
        bot.answerCallbackQuery(query.id, { text: 'No active /add flow. Use /add to start.' });
        return;
      }

      await bot.answerCallbackQuery(query.id);

      if (flow.step === 1) {
        flow.ex1  = ex;
        flow.step = 2;
        const remaining = EXCHANGES.filter(e => e !== ex);
        bot.sendMessage(chatId, `Exchange 1: ${EX_LABEL[ex]}\n\nStep 2: Select Exchange 2:`, {
          reply_markup: exchangeKeyboard(remaining),
        });
      } else if (flow.step === 2) {
        if (ex === flow.ex1) {
          bot.sendMessage(chatId, 'Exchange 2 must be different from Exchange 1. Please select again.');
          return;
        }
        flow.ex2  = ex;
        flow.step = 3;
        bot.sendMessage(chatId,
          `Exchange 1: ${EX_LABEL[flow.ex1]}\nExchange 2: ${EX_LABEL[ex]}\n\n` +
          `Step 3: Type the trading pair symbol (e.g. SOL):`
        );
      }
      return;
    }

    // Alert removal
    if (data.startsWith('remove:')) {
      const id   = parseInt(data.slice(7), 10);
      const user = getUser(chatId);
      const idx  = user.alerts.findIndex(a => a.id === id);

      await bot.answerCallbackQuery(query.id);

      if (idx === -1) {
        bot.sendMessage(chatId, 'Alert not found — it may have already been removed.');
        return;
      }

      const removed = user.alerts.splice(idx, 1)[0];
      bot.sendMessage(chatId,
        `Removed alert: ${removed.sym}  ${EX_LABEL[removed.ex1]} ↔ ${EX_LABEL[removed.ex2]}`
      );
      return;
    }
  });

  // ── Text messages (flow steps 3 & 4) ────────────────────────────────────────

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return; // skip commands

    const chatId = msg.chat.id;
    const flow   = addFlow[chatId];
    if (!flow) return;

    // Step 3: symbol input
    if (flow.step === 3) {
      const sym = normalizeSymbol(msg.text.trim());
      if (!sym) {
        bot.sendMessage(chatId, 'Invalid symbol. Please type a symbol (e.g. SOL):');
        return;
      }

      bot.sendMessage(chatId, `Checking if ${sym} is available on both exchanges…`);

      let rates;
      try { rates = await fetchAllRates(); }
      catch (err) {
        bot.sendMessage(chatId, `Error fetching rates: ${err.message}. Please try again:`);
        return;
      }

      const hasEx1 = rates[flow.ex1]?.[sym] != null;
      const hasEx2 = rates[flow.ex2]?.[sym] != null;

      if (!hasEx1 || !hasEx2) {
        const missing = [!hasEx1 && EX_LABEL[flow.ex1], !hasEx2 && EX_LABEL[flow.ex2]]
          .filter(Boolean).join(' and ');
        bot.sendMessage(chatId,
          `"${sym}" not found on ${missing}. Please type a different symbol:`
        );
        return;
      }

      flow.sym  = sym;
      flow.step = 4;

      const curArb = Math.abs(rates[flow.ex1][sym] - rates[flow.ex2][sym]) * 10_000;
      bot.sendMessage(chatId,
        `${sym} found! Current ARB: ${curArb.toFixed(1)} BPS\n\n` +
        `Step 4: Set your ARB threshold in BPS (e.g. 8):\n` +
        `You will be alerted when the ARB stays below this value for ${DROP_CHECKS} consecutive minutes.`
      );
      return;
    }

    // Step 4: threshold input
    if (flow.step === 4) {
      const bps = parseFloat(msg.text.trim());
      if (isNaN(bps) || bps <= 0) {
        bot.sendMessage(chatId, 'Please enter a positive number (e.g. 8):');
        return;
      }

      const alert = {
        id:           ++alertIdCounter,
        ex1:          flow.ex1,
        ex2:          flow.ex2,
        sym:          flow.sym,
        thresholdBps: bps,
        belowCount:   0,
        alerted:      false,
      };

      getUser(chatId).alerts.push(alert);
      delete addFlow[chatId];

      bot.sendMessage(chatId,
        `✅ Alert set: ${alert.sym} between ${EX_LABEL[alert.ex1]} and ${EX_LABEL[alert.ex2]}. ` +
        `Alert when ARB stays below ${bps} BPS for ${DROP_CHECKS} consecutive minutes.`
      );
    }
  });

  // ── Polling loop ─────────────────────────────────────────────────────────────

  async function pollRates() {
    let rates;
    try {
      rates = await fetchAllRates();
    } catch (err) {
      console.error('[Bot] Poll error:', err.message);
      return;
    }

    // Build sym → { ex → rate8h } map for high-ARB check
    const symMap = {};
    for (const ex of EXCHANGES) {
      for (const [sym, rate] of Object.entries(rates[ex] || {})) {
        if (!symMap[sym]) symMap[sym] = {};
        symMap[sym][ex] = rate;
      }
    }

    // ── Per-user ARB drop alerts ─────────────────────────────────────────────
    for (const [chatId, user] of Object.entries(users)) {
      for (const alert of user.alerts) {
        const r1 = rates[alert.ex1]?.[alert.sym];
        const r2 = rates[alert.ex2]?.[alert.sym];
        if (r1 == null || r2 == null) continue;

        const arb = Math.abs(r1 - r2) * 10_000;

        if (arb < alert.thresholdBps) {
          alert.belowCount++;
          if (alert.belowCount >= DROP_CHECKS && !alert.alerted) {
            alert.alerted = true;
            bot.sendMessage(chatId,
              `🟠 ARB ALERT: ${alert.sym} arb between ${EX_LABEL[alert.ex1]} and ${EX_LABEL[alert.ex2]} ` +
              `has been below ${alert.thresholdBps} BPS for ${DROP_CHECKS} consecutive minutes. ` +
              `Current: ${arb.toFixed(1)} BPS. Consider closing your position.`
            ).catch(e => console.error('[Bot] Send error:', e.message));
          }
        } else {
          alert.belowCount = 0;
          alert.alerted    = false;
        }
      }
    }

    // ── Global high-ARB opportunity alerts ───────────────────────────────────
    for (const [sym, exRates] of Object.entries(symMap)) {
      const entries = Object.entries(exRates);
      if (entries.length < 2) continue;

      const maxEntry = entries.reduce((a, b) => b[1] > a[1] ? b : a);
      const minEntry = entries.reduce((a, b) => b[1] < a[1] ? b : a);
      if (maxEntry[0] === minEntry[0]) continue;

      const arb = (maxEntry[1] - minEntry[1]) * 10_000;
      const key = `${minEntry[0]}|${maxEntry[0]}|${sym}`;

      if (arb > HIGH_ARB_THRESHOLD) {
        if (!highArbTrackers[key]) highArbTrackers[key] = { count: 0, alerted: false, belowCount: 0 };
        const tracker = highArbTrackers[key];
        tracker.count++;
        tracker.belowCount = 0; // reset cool-down counter while still above threshold

        if (tracker.count >= HIGH_ARB_CHECKS && !tracker.alerted) {
          tracker.alerted = true;
          const text =
            `🟢 HIGH ARB OPPORTUNITY: ${sym} arb between ${EX_LABEL[minEntry[0]]} and ${EX_LABEL[maxEntry[0]]} ` +
            `has been above ${HIGH_ARB_THRESHOLD} BPS for ${HIGH_ARB_CHECKS}+ minutes! ` +
            `Current: ${arb.toFixed(1)} BPS`;

          for (const [chatId, user] of Object.entries(users)) {
            if (user.registered) {
              bot.sendMessage(chatId, text).catch(e => console.error('[Bot] Send error:', e.message));
            }
          }
        }
      } else {
        if (highArbTrackers[key]) {
          const tracker = highArbTrackers[key];
          tracker.count = 0; // reset above-threshold streak

          if (tracker.alerted) {
            // Only lift the cooldown after 30 consecutive minutes below threshold
            tracker.belowCount = (tracker.belowCount || 0) + 1;
            if (tracker.belowCount >= 30) {
              tracker.alerted    = false;
              tracker.belowCount = 0;
            }
          }
        }
      }
    }
  }

  // Run first poll 10 seconds after startup, then every 60 seconds
  setTimeout(pollRates, 10_000);
  setInterval(pollRates, POLL_INTERVAL_MS);

  bot.on('polling_error', (err) => console.error('[Bot] Polling error:', err.message));

  bot.setMyCommands([
    { command: 'start',  description: 'Welcome and instructions' },
    { command: 'add',    description: 'Add a new ARB alert' },
    { command: 'list',   description: 'View your active alerts' },
    { command: 'remove', description: 'Remove an alert' },
    { command: 'status', description: 'Check current ARB for a symbol' },
  ]).catch(err => console.error('[Bot] setMyCommands error:', err.message));

  console.log('[Bot] Telegram bot started and polling.');
}
