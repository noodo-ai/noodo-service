# Noodo service

A read-only Hyperliquid assistant built with Fastify, SQLite/Drizzle, the official Anthropic SDK, and the Hyperliquid Info API. It exposes three business tools for markets, accounts, and fills. It cannot place or cancel orders, transfer funds, sign transactions, or fetch arbitrary URLs. The frontend is in `../noodo-app`.

See the [design](docs/crypto-ai-assistant-design.md), [engineering conventions](docs/engineering.md), and [acceptance checklist](docs/acceptance.md).

## Local setup

Use **Node.js 22 LTS** (`.nvmrc`). Service, admin, and validation scripts use the current Node 22 runtime or the newest local nvm installation of Node 22. They do not change the global runtime. After changing Node versions or CPU architecture, run `nvm use` and `npm ci` to rebuild compatible native dependencies.

```bash
nvm use
npm ci
# Only for a new checkout; preserve an existing .env.
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in the server's `.env`. Create a key in [Claude Console](https://platform.claude.com/settings/keys). API billing is required; a Claude web subscription does not provide API credits. Never put the key in chat, source code, or frontend configuration.

The model is fixed to `claude-sonnet-4-6` in `src/config.ts`; a legacy `CLAUDE_MODEL` variable cannot override it. Requests disable thinking. Check current [pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [rate limits](https://platform.claude.com/docs/en/api/rate-limits) for your account. `npm run models:list` is an account-access diagnostic, not a required setup step.

Create an invited user, then start the service:

```bash
npm run user:create -- your-username
npm run dev
```

The CLI reads a 12–256 character password without echoing it and does not need a model key. Development loads `.env` before configuration validation; existing process variables take precedence. A missing API key stops the service with a configuration error.

Start the frontend in another terminal:

```bash
cd ../noodo-app
npm install
npm run dev
```

Open `http://localhost:5173` or `http://127.0.0.1:5173` and sign in. The frontend proxies `/v1` to `127.0.0.1:3001`. Select a public main-account or specific subaccount `0x` address; agent and vault addresses are unsupported. Market queries do not require an account. No frontend API key or wallet connection is needed.

## Configuration and data scope

`.env.example` lists the configuration options. Git and Docker exclude `.env` and `.env.*`, except the example. The default database is `./data/noodo.sqlite`; startup applies versioned SQL migrations and enables foreign keys, WAL, and a busy timeout.

| Setting | Behavior |
| --- | --- |
| `ALLOWED_ORIGINS` | Exact allowed origins. Writes with missing or unlisted Origin headers are rejected. Production requires HTTPS. |
| `COOKIE_SECURE` | May be `false` only in development. Sessions expire after seven days and logout revokes them immediately. Tokens are stored as SHA-256 hashes; passwords use Argon2id. |
| `USER_DAILY_REQUEST_LIMIT` | Defaults to 50 requests per user per Shanghai calendar day. |
| `GLOBAL_DAILY_TOKEN_LIMIT` | Defaults to 1,000,000 tokens for this single instance. Each run reserves 32,000 atomically, then releases the unused portion on settlement. |
| `ANTHROPIC_REQUESTS_PER_MINUTE` | Defaults to 30; token counting and generation share the budget. Provider 429 responses start a cooldown. SDK retries, thinking, and prompt caching are disabled. |
| `HYPERLIQUID_WEIGHT_PER_MINUTE` | Defaults to 900, also the maximum. Reduce it when sharing an egress IP. |
| `SUPPORTED_ACCOUNT_MODES` | Empty by default. Set only to `disabled`, and only after verifying real account fixtures. Other values are rejected. |
| `BACKUP_ENCRYPTION_KEY` | Required for backup and verification only. Generate with `openssl rand -hex 32` and keep a separate secure copy. Losing it makes backups unreadable. |

Unconfirmed model usage is settled conservatively using verified input plus the request's output allowance. Restart recovery charges the full reservation. Duplicate requests do not reserve again.

Hyperliquid queries use a type allowlist, a 256-entry cache, shared in-flight queries, cancellation propagation, an eight-second timeout, and at most one retry for network errors, 429, or 5xx responses. Cache lifetimes are ten seconds for markets, five for accounts/modes/orders/fills, sixty for roles, and five minutes for fill-filtering metadata. Cached sources retain their original query time. Fill and candle record times are not response snapshot timestamps.

Coverage is limited to default perpetuals. Spot, HIP-3, HyperEVM, vaults, and automatic subaccount aggregation are excluded. Unknown or failed values never become zero. Unverified modes—including `default`, `unifiedAccount`, `portfolioMargin`, and `dexAbstraction`—retain raw positions but hide balances and derived risk. Synthetic fixtures do not establish real account-mode semantics.

Recent and historical fills are always identified as incomplete samples. Historical scans allow at most three fill requests, including retries, at most thirty days, and at most 1,000 output records. A stalled inclusive cursor stops the scan. An unverified retention window cannot establish complete history.

Risk calculations use decimal arithmetic, source IDs, and formula versions. They include margin usage, concentration within covered positions, long/short liquidation distance, and matching stop orders. Backend snapshots supply card values. There are no risk scores or complete historical PnL claims. Required snapshots older than ten seconds trigger one refresh; persistent inconsistency disables cross-snapshot calculations. Account value is not total wallet wealth, and withdrawable balance is not buying power.

## API and recovery

Browser authentication uses an HttpOnly cookie. Every conversation and run is owner-scoped; another user's resource returns 404. Request schemas and public errors live in `src/contracts.ts`.

A new `POST /v1/conversations/:id/messages` returns SSE and `X-Run-Id`. The same `clientRequestId` and payload return JSON `{runId,status,resultUrl}`; a changed payload returns 409. Duplicate lookup precedes new-request version, quota, and concurrency checks, so an old request remains recoverable after an account change. Each conversation allows one running request; the service allows ten globally.

The frontend saves the original request before POST and handles SSE or JSON according to Content-Type. A disconnect retrieves `GET /v1/runs/:id`; uncertain submissions retain the original ID. Only explicit retries use new IDs. Requests older than thirty days are not replayed. Saved run results are authoritative for text and cards. There is no event replay or background continuation.

Tools save snapshots before emitting completion events. Text checkpoints run every second or every 1,000 characters. Terminal state, assistant message, and token settlement commit together; late callbacks cannot overwrite them. Cancellation, network loss, and restart preserve partial or unavailable results. External work has 55 seconds, leaving five seconds for persistence. Limits are three tool rounds, six tool executions, four model calls, 2,000 output tokens per call, 24,000 cumulative input tokens, and 8,000 cumulative output tokens. Input is counted before generation.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run upstream:check
```

`upstream:check` reads real BTC market data and validates the Hyperliquid contract; it does not need a Claude key. Automated tests use clearly identified synthetic API fixtures and replaceable model providers. They cover risk boundaries, account roles/modes, failed queries, pagination, truncation, caching, atomic quotas, deduplication, isolation, SSE, model failures, disconnects, restart recovery, and backups.

Live Claude evaluation requires a configured key. Mock-provider success does not prove live model availability; synthetic account fixtures do not verify real account modes. Full browser integration, real account checks, and deployment verification remain on the [acceptance checklist](docs/acceptance.md).

## Single-instance production and backups

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

Inject production configuration through the deployment platform. Use persistent storage and one API instance. The Dockerfile builds the service, but deployment must still provide keys, origins, HTTPS, and a volume mounted at `/app/data`. Run admin commands in a controlled environment with source and development dependencies; never expose them as HTTP endpoints.

Serve the app and API from one HTTPS origin. Disable SSE buffering and caching, allow at least 75 seconds for proxy reads, and preserve Origin and cookies. The service sends a heartbeat every fifteen seconds. It does not trust arbitrary `X-Forwarded-For`; limit login traffic at a trusted proxy rather than enabling unrestricted `trustProxy`. Logs contain internal IDs, error codes, tokens, latency, and tool/cache counts—not raw chats, full addresses, cookies, or tool responses. Configure log rotation with seven-day retention.

Schedule these admin commands daily through your deployment platform:

```bash
npm run db:backup
npm run db:verify -- backups/<backup-file>.enc
npm run db:prune
```

No scheduler is created by this repository. Backups use SQLite's online backup API and AES-256-GCM, with file mode 0600 and default directory mode 0700. Backup commands remove matching default-named backups older than seven days. Do not copy an active SQLite file without its WAL.

Verification decrypts into an independent temporary database, checks integrity and foreign keys, recovers running requests, validates settlement and sources, then removes the plaintext. It never overwrites the live database. Chat runs, linked messages, and snapshots expire after thirty days; running requests and the current quota day are retained. Backups can retain expired data for up to seven additional days; disclose that during the trial.

Targets are a 24-hour RPO and four-hour RTO. Before trial access, complete a real encrypted backup/restore drill, account-mode verification, twenty live Claude evaluations, browser integration, and HTTPS/SSE checks in the deployed environment.

## Troubleshooting

Startup errors distinguish configuration, native dependencies, database access, and port binding without exposing secrets or raw provider errors.

- Missing Node 22: run `nvm install 22`.
- Native dependency mismatch: run `nvm use` and `npm ci`; preserve `.env` and the database.
- Port occupied: stop the other development process or change `PORT` and the frontend proxy together.
- Database unavailable or locked: check `DATABASE_PATH`, directory permissions, and other service processes.
