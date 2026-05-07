# Scan Slop

Captcha verification + link spam detection for Reddit subreddits. A free, open-source moderation tool that runs as a Devvit app on Reddit, with a Cloudflare Worker handling the captcha image and analytics dashboard.

Live: https://developers.reddit.com/apps/scanslop · https://scanslop.com/reddit-how-it-works

## Project layout

- `devvit-app/` - the Reddit Developer Platform (Devvit) app: triggers, captcha logic, link spam detection, scheduler jobs.
- `worker/` - Cloudflare Worker that serves the captcha page, the moderator dashboard, analytics APIs, and static info pages.
- `.github/workflows/deploy.yml` - CI/CD that deploys both on push to `main`.

## Architecture

Devvit app and Worker communicate via a Telegram channel relay (since Devvit can only fetch from a small allowlist of domains, and `api.telegram.org` is one of them). Two bots are admins of one private channel:
- Bot A (Worker -> Devvit): the Worker uses Bot A to send commands. Devvit reads them via Bot B's `getUpdates`.
- Bot B (Devvit -> Worker): Devvit uses Bot B to send events (link detections, bans). Worker reads them via Bot A's `getUpdates`.

This is a workaround. If your domain is on Reddit's fetch allowlist, you don't need it.

## Setup

### 1. Worker (Cloudflare)

```bash
cd worker
npm install -g wrangler
wrangler login

# Create resources
wrangler d1 create scanslop-analytics       # copy the database_id into wrangler.toml
wrangler kv namespace create ASSETS          # copy the id into wrangler.toml

# Initial schema
wrangler d1 execute scanslop-analytics --remote --command="CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, ip TEXT, country TEXT, city TEXT, asn INTEGER, asn_org TEXT, user_agent TEXT, is_bot INTEGER, visited_at TEXT, subreddit TEXT)"
wrangler d1 execute scanslop-analytics --remote --command="CREATE TABLE IF NOT EXISTS ip_reputation (ip TEXT PRIMARY KEY, is_proxy INTEGER, country TEXT, isp TEXT, checked_at TEXT)"
wrangler d1 execute scanslop-analytics --remote --command="CREATE TABLE IF NOT EXISTS link_promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, subreddit TEXT, username TEXT, domain TEXT, source_type TEXT, source_id TEXT, post_id TEXT, detected_at TEXT)"
wrangler d1 execute scanslop-analytics --remote --command="CREATE TABLE IF NOT EXISTS ban_events (id INTEGER PRIMARY KEY AUTOINCREMENT, subreddit TEXT, username TEXT, action TEXT, reason TEXT, duration INTEGER, banned_at TEXT)"
wrangler d1 execute scanslop-analytics --remote --command="CREATE TABLE IF NOT EXISTS pending_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, subreddit TEXT, action TEXT, target TEXT, params TEXT, requested_by TEXT, status TEXT DEFAULT 'pending', created_at TEXT, processed_at TEXT)"
wrangler d1 execute scanslop-analytics --remote --command="CREATE TABLE IF NOT EXISTS kv_state (key TEXT PRIMARY KEY, value TEXT)"

# Set secrets
wrangler secret put CAPTCHA_SECRET_KEY      # any random string, must match Devvit
wrangler secret put TELEGRAM_BOT_TOKEN      # Bot A token (used to send messages)
wrangler secret put TELEGRAM_CHAT_ID        # private channel id (e.g. -100xxxxxxxxxx)

wrangler deploy
```

### 2. Devvit app

```bash
cd devvit-app
npm install
cp src/config.example.ts src/config.ts
# Edit src/config.ts with your values (Worker URL, secret key, Bot B token, channel id)
npx devvit login
npx devvit upload
```

### 3. Telegram setup

Create two bots via [@BotFather](https://t.me/BotFather) on Telegram:
- One for the Worker to post commands (Bot A token -> `TELEGRAM_BOT_TOKEN` Worker secret)
- One for Devvit to read (Bot B token -> `TELEGRAM_READER_TOKEN` in Devvit config)

Create a private Telegram channel and add **both** bots as admins with "Post messages" permission. Get the channel id (negative number starting with `-100`) by sending a test message and checking `https://api.telegram.org/botBOT_A_TOKEN/getUpdates`.

## Deployment via CI

GitHub Actions deploys both the Devvit app and the Worker on push to `main`. Set the following repository secrets:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard - API tokens, edit Workers permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard, top right |
| `WORKER_CAPTCHA_SECRET_KEY` | Random string, must match Devvit config |
| `WORKER_TELEGRAM_BOT_TOKEN` | Bot A token |
| `WORKER_TELEGRAM_CHAT_ID` | Channel id |
| `DEVVIT_TOKEN` | Devvit auth token from `~/.devvit/token` after `npx devvit login` |
| `DEVVIT_CAPTCHA_SERVER_URL` | Worker URL (e.g. `https://scanslop.com`) |
| `DEVVIT_CAPTCHA_SECRET_KEY` | Same as `WORKER_CAPTCHA_SECRET_KEY` |
| `DEVVIT_TELEGRAM_READER_TOKEN` | Bot B token |
| `DEVVIT_TELEGRAM_CHAT_ID` | Channel id |

## License

MIT - see `LICENSE`.
