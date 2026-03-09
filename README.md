# Funding Rate Arbitrage Screener

A real-time screener for perpetual DEX funding rates, designed to identify delta-neutral arbitrage opportunities across multiple exchanges.

<!-- Add screenshot here -->

---

## What It Does

The screener aggregates live funding rates from several perpetual DEX exchanges and computes the maximum arbitrage spread (MAX ARB) for each symbol — the difference between the highest LONG rate and the highest SHORT rate across all tracked exchanges. This lets you instantly spot delta-neutral opportunities where you can earn funding by going long on one exchange and short on another for the same asset.

---

## Features

- **Live funding rates** from Hyperliquid, Variational, Aster, and 01Exchange
- **Delta-neutral arbitrage opportunities** sorted by MAX ARB spread
- **Exchange filter, favorites, and symbol search** for quick navigation
- **LONG / SHORT highlighting** with color-coded cells per exchange
- **Display unit toggle** — switch between 1h, 8h, and APY in BPS or %
- **Funding countdown timer** showing time until the next funding payment
- **Telegram bot** with custom ARB threshold alerts and high-opportunity notifications

---

## Requirements

- Node.js 18+
- A Telegram bot token (for alert functionality) — obtain one via [@BotFather](https://t.me/BotFather)

---

## Installation

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd fundingscreener

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Open .env and fill in your TELEGRAM_BOT_TOKEN

# 4. Start the server
npm start

# 5. Open the app
# Navigate to http://localhost:3000 in your browser
```

---

## Telegram Bot

The bot sends alerts when funding rate arbitrage opportunities exceed your configured threshold.

### Commands

| Command | Description |
|---------|-------------|
| `/start` | Activate the bot and register your chat |
| `/add <symbol> <threshold>` | Add an alert for a symbol when MAX ARB exceeds the threshold (in BPS) |
| `/list` | List all your active alerts |
| `/remove <symbol>` | Remove an alert for a symbol |
| `/status` | Show current top arbitrage opportunities |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token from @BotFather |

---

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS (single page)
- **Data:** Direct exchange APIs, normalized server-side to 8h BPS
