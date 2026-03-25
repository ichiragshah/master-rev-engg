# Book Guard

Betting exposure monitoring service with Telegram alerts. Tracks net exposure across multiple betting platforms and sends real-time alerts when positions change.

## How It Works

1. **Register** a client (betting account) via the web form or API
2. **Link Telegram** by sending `/start` to the bot
3. **Start monitoring** with `/chalu` — the poller checks exposure every 30s
4. **Stop monitoring** with `/khatam` — zero API calls until reactivated

Polling is on-demand. The server idles until a Telegram user activates it. Multiple clients can be linked to a single Telegram user — `/chalu` activates polling for all of them.

## Architecture

```
Railway (always running)
  ├── Express server         — web UI, registration API, Telegram webhook
  ├── Poller (on-demand)     — polls betting APIs every 30s when activated
  ├── Residential proxy      — all upstream API calls routed via iproyal (Mumbai IP)
  └── PostgreSQL             — clients, alert recipients, tokens
```

## Supported Platforms

| Platform | API Base |
|----------|----------|
| Winner7  | playexchwin.com |
| LeoExch  | winzone.uk |

Each platform has its own login flow, market parsing, and session handling defined in `platforms.js`.

## Telegram Commands

| Command   | Description |
|-----------|-------------|
| `/start`  | Link your Telegram account |
| `/chalu`  | Start monitoring (activates polling) |
| `/khatam` | Stop monitoring (deactivates polling) |
| `/status` | View your config and linked clients |

## Project Structure

```
server.js        — Express app, routes, startup
poller.js        — On-demand polling loop, activePollers Set
telegram.js      — Bot commands, webhook handler, alert formatting
db.js            — PostgreSQL schema, queries, migrations
platforms.js     — Platform configs (login, markets, parsing)
proxy-fetch.js   — HTTP client routed through residential proxy
auth.js          — Login, token management, session refresh
headers.js       — Browser-like request headers per platform
crypto.js        — AES encrypt/decrypt for stored passwords
```

## Database Schema

**clients** — registered betting accounts
- `username`, `password_enc`, `platform`, `active`
- `token`, `token_expiry`, `user_id` (cached session)
- `sports`, `book_view`, `threshold`, `alert_type`

**alert_recipients** — Telegram users linked to clients
- `client_id` (FK), `telegram_username`, `telegram_chat_id`
- One client can have multiple recipients
- One Telegram user can be linked to multiple clients

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token |
| `BOT_USERNAME` | Bot username (shown in registration response) |
| `APP_URL` | Public URL for Telegram webhook |
| `CRYPTO_SECRET` | AES key for password encryption |
| `RESIDENTIAL_PROXY_URL` | Residential proxy URL (iproyal) |
| `ADMIN_KEY` | Key for `/admin/clients` endpoint |

## Deployment

Runs on **Railway** with auto-deploy from `main` branch. All upstream betting API calls are routed through a residential proxy to avoid datacenter IP blocks.

```bash
# Check logs
railway logs --lines 30

# Set env vars
railway variables set KEY=VALUE
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Register a new client |
| `POST` | `/telegram-webhook` | Telegram bot webhook |
| `GET`  | `/admin/clients` | List all clients (requires `x-admin-key` header) |
| `GET`  | `/health` | Health check |
