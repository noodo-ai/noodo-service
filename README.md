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

Browser authentication uses an HttpOnly cookie. Every conversation and run is owner-scoped; another user's conversation or run returns 404. Request schemas and public errors live in `src/contracts.ts`.

Owner-scoped `DELETE /v1/conversations/:id` returns `{deleted:true}`. Active runs return 409. Deletion atomically clears messages, tool snapshots, saved results, errors, and addresses and hides the conversation and its runs (404). Redacted run accounting remains until normal retention expires so deletion cannot reset daily quotas. Existing encrypted backups retain their usual seven-day lifetime.

A new `POST /v1/conversations/:id/messages` returns SSE and `X-Run-Id`. The same `clientRequestId` and payload return JSON `{runId,status,resultUrl}`; a changed payload returns 409. Duplicate lookup precedes new-request version, quota, and concurrency checks, so an old request remains recoverable after an account change. Each conversation allows one running request; the service allows ten globally.

The frontend saves the original request before POST and handles SSE or JSON according to Content-Type. A disconnect retrieves `GET /v1/runs/:id`; uncertain submissions retain the original ID. Only explicit retries use new IDs. Requests older than thirty days are not replayed. Saved run results are authoritative for text and cards. There is no event replay or background continuation.

Tools save snapshots before emitting completion events. Text checkpoints run every second or every 1,000 characters. Terminal state, assistant message, and token settlement commit together; late callbacks cannot overwrite them. Cancellation, network loss, and restart preserve partial or unavailable results. Model calls and runs have no elapsed-time cutoff; caller cancellation and Hyperliquid query timeouts remain active. Limits are three tool rounds, six tool executions, four primary model calls plus at most two tool-free compression calls, 2,000 output tokens per call, 24,000 cumulative input tokens, and 8,000 cumulative output tokens. Input is counted before generation. Answer drafts are buffered until validated; final answers target 900 Unicode characters and must fit within 1,200, including whitespace and Markdown. Oversized or token-truncated drafts are rewritten using existing evidence before publication.

## Resources API and storage

Resource metadata, attachments (SQLite BLOBs), personal categories, and view accounting live in the existing database and its encrypted backups. Migration 0004 is applied on startup. Resource data does not expire with the thirty-day chat retention window. Use persistent storage; this remains a single-instance design without object storage or document conversion services.

- `GET /v1/resources`: `scope=community|personal`, `search` (title/summary), `topic`, `format`, `visibility`, personal `categoryId`, `sort=latest|popular`, `limit` (1–30), `offset`. Returns metadata/files and `nextOffset`; report bodies and attachment bytes are excluded.
- `POST /v1/resources`: title, summary, Markdown body, `visibility` (default private), nullable categoryId, topic, and up to five `{name,base64}` files. `PATCH /v1/resources/:id` replaces editable metadata/body; existing attachments stay attached. `DELETE` removes the resource, its files, and view records.
- `GET /v1/resources/:id` and `/v1/resources/:id/files/:fileId` check current visibility. File downloads use attachment disposition; `?preview=1` uses the validated MIME type. Responses use no-store caching and file responses disable sniffing.
- `POST /v1/resources/:id/view` records a signed-in non-owner reader for public resources. Popular ranks unique readers in the past seven days. Views are independent of reading and do not affect AI quotas.
- `GET|POST /v1/resource-categories` and `PATCH|DELETE /v1/resource-categories/:id` manage owner-only categories. GET also returns `usedBytes` and `limitBytes`. Deleting a category preserves uncategorized resources.

Public resources are readable by any signed-in user; another user's private resource or attempted mutation returns 404. Categories are always owner-scoped and their IDs are hidden from other readers. Writes retain the Origin check and use a per-user rate limit. Supported topics are Research, Markets, Trading, Data, Other. Allowed file extensions are md, txt, csv, json, pdf, png, jpg/jpeg, webp; text requires UTF-8, JSON must parse, and binary files require matching signatures. HTML, SVG, office files and executable content are excluded. No OCR or AI indexing is performed.

Quota checks and resource/file writes run in one SQLite transaction: 10 MiB of body plus attachments per resource, 100 MiB and 1,000 resources per owner, 50 categories per owner. Resource creation has a 15 MiB JSON transport limit for base64 overhead; metadata edits have a 2 MiB transport limit to accommodate the full 200,000-character body, including JSON Unicode escapes. Files are stored once; backups continue to retain deleted data for their usual seven-day lifetime. Resource attachments are included in database backups, so monitor disk and backup size as user count grows.

## Trends API and scheduled observations

`GET /v1/trends` requires a session and returns stored highlights, top-five traders, at most 100 recent events, scope, source IDs, last-success timestamps, and independent source failure/staleness flags. `marketSource` identifies the latest market snapshot by `sourceId` and `at`; `interestBaseline` identifies the snapshot used for hourly OI comparisons. Each is null when unavailable, and these references are returned even when no signal fires. Reads never initiate upstream work. No AI calls or user model quota are involved. Migration 0005 stores bounded snapshots and events in SQLite, covered by normal encrypted backups.

The single-instance service starts its collector on listen and aborts/awaits it on shutdown. Markets are collected every five minutes with the same InfoClient cache/weighted limiter as chat. The public `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` is read hourly with an eight-second timeout; this is an undocumented, independently failing contract, validated on every fetch. Eligible user/subaccount addresses in its five highest reported weekly PnL entries are sampled every fifteen minutes. Agent/vault/missing roles are skipped. Balances and derived account risk are not used. Failed source updates preserve prior data and retry no more often than the five-minute collection interval (market failures can retry on the scheduler's next minute).

Rules: absolute underlying OI change of at least 10% against a 55–65-minute-old snapshot; hourly funding crossing between nonzero signs with at most a ten-minute gap; rank changes within the previously stored top five; and signed position changes of at least $1 million estimated with a market snapshot at most ten minutes old. Position baselines older than twenty minutes are ignored. Snapshot changes do not prove individual trades, all-market activity, or trading intent. USD deltas use current marks; OI changes use underlying units. Ranking uses source-reported seven-day PnL and does not assess risk-adjusted skill. The stats endpoint is not filtered by DEX; its performance may cover other markets. Only position tracking and market cards are limited to default perpetuals. Volume cards show reported rolling 24-hour volume, not invented volume spikes.

The collector stores up to sixteen market snapshots over seventy minutes, one snapshot per tracked address, and up to 100 events over seven days. Duplicate rule/coin signals are suppressed for one hour. The hourly comparison warms up after startup when no persisted baseline exists. This feature covers default perpetuals only; it does not add spot, HIP-3, global liquidations, realtime large-trade streams, or guaranteed history. Collection runs only while the API process is online. Market data becomes stale after ten minutes, leaderboard after two hours, and position sampling after thirty minutes; failed refreshes are reported immediately.

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

No backup scheduler is created by this repository. Backups use SQLite's online backup API and AES-256-GCM, with file mode 0600 and default directory mode 0700. Backup commands remove matching default-named backups older than seven days. Do not copy an active SQLite file without its WAL.

Verification decrypts into an independent temporary database, checks integrity and foreign keys, recovers running requests, validates settlement and sources, then removes the plaintext. It never overwrites the live database. Chat runs, linked messages, and snapshots expire after thirty days; running requests and the current quota day are retained. Backups can retain expired data for up to seven additional days; disclose that during the trial.

Targets are a 24-hour RPO and four-hour RTO. Before trial access, complete a real encrypted backup/restore drill, account-mode verification, twenty live Claude evaluations, browser integration, and HTTPS/SSE checks in the deployed environment.

## Troubleshooting

Startup errors distinguish configuration, native dependencies, database access, and port binding without exposing secrets or raw provider errors.

- Missing Node 22: run `nvm install 22`.
- Native dependency mismatch: run `nvm use` and `npm ci`; preserve `.env` and the database.
- Port occupied: stop the other development process or change `PORT` and the frontend proxy together.
- Database unavailable or locked: check `DATABASE_PATH`, directory permissions, and other service processes.
