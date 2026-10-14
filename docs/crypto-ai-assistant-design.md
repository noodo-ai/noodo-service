# Noodo Hyperliquid AI assistant design

Design baseline: October 12, 2026. The MVP supports read-only Hyperliquid analysis. Transaction execution is a later phase; Base, multiple chains, queues, and automation are outside the current scope.

The first goal is to let a user include a public Hyperliquid address in chat and understand markets, positions, and account risk through chat: ask a question, query real data, calculate metrics, and explain the results.

## Product scope

Hyperliquid provides a focused starting point for trading analysis with fewer asset-mapping, wallet-indexing, and provider dependencies than a cross-chain product. Its [Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) supports public market and account queries. Queries use a main-account or specific subaccount address, never a substitute agent address.

Only default perpetual markets listed in metadata, such as BTC, ETH, and HYPE, are covered. HIP-3, spot, HyperEVM assets, vaults, and automatic subaccount aggregation are excluded. Responses must state that scope and must not call a partial snapshot the user's complete assets.

| Task | Example | Result |
| --- | --- | --- |
| Markets | What are BTC's price, funding, and open interest? | Mark price, hourly funding, OI, volume, and optional recent candles. |
| Accounts | Show this address's positions. | Covered account summary, long/short positions, unrealized PnL, leverage, and provider liquidation prices. |
| Risk | Which positions need attention? | Code-calculated margin use, concentration, liquidation distance, and matching orders, explained by the model. |
| Fills | Show recent fills. | A bounded sample with direction and fees, without claims of complete historical returns. |

The user enters a public address without connecting a wallet, signing, or providing a private key. Validate `0x` followed by forty hexadecimal characters and normalize it. Resolve one distinct full address directly from each user message and save it on the conversation atomically with run acceptance. Follow-ups without an address reuse this context. Multiple distinct or malformed address candidates clear the context and require clarification in chat. The model infers intent and chooses market, account, or fill tools; it cannot query an address other than the run’s resolved address. Account questions require a resolved address, while market queries do not. An observed address does not prove ownership; history remains private to the signed-in user.

Provide one chat mode, example questions, and source cards. Hide unimplemented Deep Think and Create modes. The MVP has no order placement/cancellation, leverage changes, transfers, agent authorization, automatic trading, backtesting, alerts, news retrieval, full PnL, or research reports. Explain these limits when asked to trade; never claim execution.

## Architecture

Use one TypeScript/Fastify API process, one SQLite database on persistent storage, Anthropic Claude, and a Hyperliquid adapter. The API authenticates requests and streams SSE. A bounded model loop calls three read-only tools. Tools query Hyperliquid and calculate deterministic risk. SQLite stores conversations, requests, and snapshots.

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 22 LTS and TypeScript |
| Contracts | Zod and generated JSON Schema |
| Persistence | SQLite, Drizzle, versioned SQL migrations |
| Model | Official Anthropic TypeScript SDK and Messages API behind a small provider interface |
| Data | Official Hyperliquid Info API with a query-type allowlist |
| Calculations | Decimal arithmetic; no floating-point financial calculations |
| Cache | Bounded in-process TTL cache |
| Deployment | Single instance, HTTPS, environment configuration, structured logs, health checks |

Do not add LangGraph, Redis, BullMQ, workers, object storage, vector databases, microservices, multiple models, or multiple agents preemptively. Add PostgreSQL when multiple instances are needed and a queue when background jobs are needed.

### Claude integration

Keep `ANTHROPIC_API_KEY` server-side. The implementation fixes the model to `claude-sonnet-4-6`; a legacy `CLAUDE_MODEL` variable does not override it. Thinking is explicitly disabled. Live evaluation must verify tool selection, explanations, latency, and cost. A Claude web subscription does not provide API credits.

The provider handles tool declarations, complete tool inputs, streamed text, usage, and error mapping. Generate `input_schema` from the same Zod contracts used to validate execution. Pair every `tool_use` with a `tool_result` by ID, including errors. Preserve assistant call blocks and user result blocks together when trimming context. Persisted messages and tool calls retain the information needed to reconstruct context. The final response disables tools; tool-argument deltas must never appear as answer text.

Set output limits on every request and `maxRetries=0`. Counting and generation share caller cancellation and provider rate limits; model requests and the overall run have no elapsed-time cutoff. Hyperliquid queries retain their own network timeouts. Count input before generation; a failed count is an explicit error. Extended thinking and prompt caching are off. Sum input/output usage across calls and charge uncertain usage conservatively. Save provider, actual model, and adapter version. Verify account pricing, limits, and SDK fields against [Anthropic documentation](https://docs.anthropic.com/).

### Local configuration

Copy the committed `.env.example` to `.env` only on a new checkout, then set the server API key. Development uses Node's `--env-file=.env` before validation and SDK setup. Injected process variables take precedence. Missing keys stop startup with the variable name, never the secret value. Production reads deployment-injected variables and does not require `.env`.

Exclude local environment files from Git and Docker while retaining `.env.example`. Never put secrets in frontend `VITE_*` variables. Vite proxies `/v1` to the local service; the allowed origins list includes the configured frontend URL. Production uses HTTPS and Secure cookies. Insecure cookies are allowed only in development. The admin CLI creates invited users; local development retains authentication, permissions, and quotas. See the [README](../README.md) for commands.

## Business tools

| Tool | Input | Internal queries |
| --- | --- | --- |
| `get_market_overview` | Default-market coin and optional candle interval | `metaAndAssetCtxs`, optionally `candleSnapshot`; bounded recent candles, at most 200, validated interval. |
| `get_account_overview` | The run's fixed account address | `userRole`, `userAbstraction`, `clearinghouseState`, `frontendOpenOrders`, `metaAndAssetCtxs`, then risk calculations. |
| `get_recent_fills` | Fixed address and bounded time range | `userRole`, default-market metadata, then `userFills` for recent samples or `userFillsByTime` for explicit historical intervals. |

Info queries use HTTP POST but are read-only operations. Allow only `https://api.hyperliquid.xyz/info` and the listed query types. Do not expose arbitrary REST access. Where supported, force `dex=""`. Filter orders and fills against default-perpetual metadata; default-DEX responses may still contain spot records.

Match metadata and asset contexts by index within the same `metaAndAssetCtxs` response. Never combine independently cached metadata with newer contexts. Preserve Hyperliquid coin names; do not invent BTCUSDT-style aliases. Reject unsupported assets. Delisted or unverifiable historical assets become `excludedUnknownAsset` rather than being guessed into scope.

### Roles, modes, sources, and freshness

Role and mode queries are internal dependencies, not additional model tools. Continue for `user` and `subAccount`; reject `agent` and `vault` without following a returned parent address. `missing` means no account found, not zero assets. A failed role query stops account/fill queries.

Derived risk supports only `disabled` mode, and only after real fixtures verify its semantics. Default configuration enables no modes. Treat `default`, `dexAbstraction`, `unifiedAccount`, `portfolioMargin`, unknown modes, and failed mode queries as unsupported: retain raw perpetual positions but hide balances and derived conclusions. Never infer mode from a zero balance. Unified and portfolio account balances require spot data that is outside this MVP. See [account modes](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-a-users-abstraction-state) and [perpetual account queries](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals).

Every tool returns `data`, `sources`, `coverage`, and `warnings`. Sources record `sourceId`, `toolCallId`, provider, query type, `fetchedAt`, cache status, and any provider timestamp. Cache hits preserve the original fetch time. Label query time when no provider snapshot time exists; fill/candle record time is not response snapshot time. Cards and derived metrics reference source IDs and formula versions. Save the actual tool snapshot used in the answer. Coverage includes market scope, selected address, completeness, and reason codes; partial failures remain visible.

Cache lifetimes are ten seconds for markets, five for accounts/modes/orders/fills, sixty for roles, and five minutes for independent fill metadata. Cache keys include network, DEX, normalized address, and query parameters; capacity is bounded. This is a cache policy, not a real-time guarantee. Query prices for all positions together.

If required snapshots are over ten seconds old or account time and price-fetch time differ by over ten seconds, refresh once. If still inconsistent, keep raw data, mark `snapshotSkew`, and disable affected cross-snapshot metrics. Without provider time, compare query times and disclose that snapshots are not atomic. Invalid mark prices disable corresponding liquidation distances. Failures never become zero balances.

### Fill pagination

Default to a recent seven-day sample, with a thirty-day maximum interval, 1,000 output rows, and three fill requests including retries; role queries are separate. Use `aggregateByTime=false` and fix `endTime` when execution starts.

Recent queries filter `userFills` by range and market, sort by descending time with stable trade-ID order, and retain the latest 1,000 records. Explicit historical intervals use `userFillsByTime` from the start forward. If the budget ends before reaching the interval end, label the result as partial historical fills; early records are not the latest fills.

The documented upstream limits are 2,000 recent fills and 2,000 per historical request within a retained 10,000-fill window. Generic pagination documentation also mentions 500-record blocks; validate endpoint behavior with boundary fixtures rather than relying on response length alone. Advance using the raw mixed-market page's maximum timestamp before filtering. Use that timestamp as an inclusive cursor. Deduplicate by account, coin, and `tid`; retain IDs as strings, not `oid` or hash substitutes. If tied timestamps prevent cursor progress, stop with `boundaryStalled`; never add a millisecond and silently skip records.

Coverage also records requested/returned ranges, scanned-through time, sort order, excluded count, and truncation reasons. Empty results use a null returned range. Complete coverage requires verified retention, complete enumeration, and no truncation, failure, or stalled boundary. The MVP has not verified retention, so historical queries remain incomplete with `retentionUnverified`. Empty or small samples do not prove an empty history; returned endpoints do not establish continuous coverage. See [fill API documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).

### Timeouts and upstream limits

Info requests time out after eight seconds, with a seventeen-second shared-query budget. Model requests and the overall run have no elapsed-time cutoff; caller cancellation still stops work. Info network errors, 429, and 5xx allow one retry using Retry-After or jittered backoff within the query budget. Invalid input, permission failures, and schema mismatches are not retried. Failed orders or prices do not hide successful raw positions; report unknown stop status or missing prices. Candle failure does not invalidate the market summary.

Use a process-wide weighted budget of at most 900 per minute, reduced for a shared egress IP. The documented upstream total is 1,200/minute; `userRole` costs sixty, and fills/candles add response-size weight. Role caching, shared in-flight queries, and 429 cooldown use the same budget. Stop with `upstreamRateLimited` when waiting would exceed the deadline. See [official limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits).

## Risk calculations

Prefer raw `accountValue`, `totalMarginUsed`, `withdrawable`, `positionValue`, `unrealizedPnl`, `leverage`, and `liquidationPx`. Withdrawable balance is not buying power; configured leverage is not actual account leverage.

- Margin usage is `marginSummary.totalMarginUsed / marginSummary.accountValue`. Do not mix in cross-margin summaries. Nonpositive equity has no normal percentage. This excludes potential additional order margin and is not distance to liquidation.
- Concentration is absolute position notional divided by total absolute notional of covered positions. A zero denominator is not applicable; incomplete asset coverage must be disclosed.
- Long liquidation distance is `(markPx - liquidationPx) / markPx`; short distance is `(liquidationPx - markPx) / markPx`. Require positive prices and valid snapshots. Null is unknown. Nonpositive distance needs verification; never clamp it to zero or infer liquidation. Cross-margin liquidation prices can change with other positions and equity.
- Match stop orders by account, coin, closing direction, trigger flag, trigger condition, and stop type. `reduceOnly` alone is insufficient. Say no match was found only after a complete successful query. Failed queries mean unknown status. A matching order does not guarantee full protection.

Label cross and isolated margin. Missing numeric JSON fields use null with a reason, not a string in a numeric field. Verify semantics for supported modes before enabling them.

`markPx` is mark price, not last trade. Funding is hourly: positive means longs pay shorts, negative means shorts pay longs. Do not annualize by default or promise the next settlement rate. OI is underlying units; `openInterest * markPx` is an estimated USD notional. `dayNtlVlm` is 24h USD notional volume. See [funding documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding).

Transmit decimal strings and calculate without early rounding. Display amounts with two decimals, percentages usually with two, funding with four, and prices at asset precision. Tiny nonzero values use a threshold display. Derive direction from the sign of `szi`; zero is neither long nor short. Keep fee currencies separate.

Code determines attention order: missing data or unsupported-mode notices first, then ascending valid liquidation distance, descending concentration for ties, then coin. Show concentration and stop status as supporting facts. Unknown distance is never safe. Do not invent high/medium/low thresholds or combined scores. The model only explains calculated facts; it does not predict guaranteed price direction or infer complete returns, win rates, equity curves, funding, or cash flows from limited fills.

## Conversation execution and access

Authenticate and check ownership, then atomically validate the account version, reserve quota, resolve the message address and increment its version when changed, save the user message, and create a running request. Load recent context with the run's fixed address, query validated tools, calculate, explain, save the terminal result, then emit completion. Fix `observedAddress`, `addressVersion`, and `marketScope` per run; reject tools that request another address.

Allow three tool rounds, six business-tool executions, and up to four primary model calls, including a final tool-free call. Allow up to two additional tool-free compression calls for an oversized or token-truncated final answer, within the same cumulative token budgets. Internal Info queries have their own weighted budget and network timeouts. Each model call allows 2,000 output tokens; each run allows 24,000 cumulative input and 8,000 cumulative output tokens with a 32,000-token initial reservation. Trim model context deterministically while retaining full snapshots in storage. Budget failures return saved results and explicit limits. Provider failures are not automatically retried. Final answers target 900 Unicode characters and must fit within 1,200, including whitespace and Markdown. Buffer each round's text until completion; publish tool preparation events immediately and publish validated text afterward. Rewrite oversized or token-truncated final drafts using the existing evidence before sending them to the client. Never publish rejected drafts as complete answers; fail explicitly if two rewrites cannot meet the limit. Preserve partial drafts on cancellation or transport failure for recovery.

Context includes at most twelve recent messages without a per-message character limit. Preserve full user input; HTTP body and model token budgets still apply. There is no long-term memory, summary system, or retrieval layer. Historical messages retain their address labels and are never current evidence for a newly selected account.

Invite-only accounts use CLI-created Argon2id password hashes and hashed random session tokens. Cookies are HttpOnly, Secure in production, SameSite=Lax, with seven-day absolute expiry and immediate logout revocation. Frontend and API share an origin; writes require an allowed Origin header. Admin commands remain separate. Session-derived ownership is checked on every conversation/run access; cross-user resources return 404. Rate-limit login by IP/account and chat by user. Do not expose anonymous unlimited calls.

Keep model keys server-side and redact logs. External content cannot expand tool permissions. Do not fetch user-provided URLs or store private keys or trading credentials.

## API and storage

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/auth/me` | Invited-account sessions; no public registration. |
| `POST /v1/conversations` | Create a conversation with an optional observed address. |
| `GET /v1/conversations` | List the current user's conversations. |
| `GET /v1/conversations/:id` | History, current address, saved runs, and active run. |
| `PATCH /v1/conversations/:id` | Update address with `expectedAddressVersion`; reject while a run is active. |
| `POST /v1/conversations/:id/messages` | Deduplicate by client request ID; execute and stream new requests. |
| `GET /v1/runs/:id` | Saved status, text, cards, and errors. |
| `GET /health` | Process and database health. |

Creation returns an initial address version of one. Address updates, including addresses resolved from accepted messages, increment it; clients synchronize the resolved address/version from run results before sending follow-ups; stale versions return 409/`addressVersionConflict`, active runs return 409/`conversationBusy`. History defaults to fifty messages, maximum one hundred, with a stable `createdAt/id` cursor.

Example message payload:

```json
{
  "clientRequestId": "a51437d3-874c-40d2-b571-7c950d71917a",
  "text": "Which positions need attention?",
  "expectedAddressVersion": 1
}
```

Save the UUID before sending. New requests return 200 SSE with `X-Run-Id` and `run.started`. Duplicate ID plus matching payload returns JSON `{runId,status,resultUrl}` without another stream. A mismatched payload returns 409/`idempotencyConflict`. Select the client parser by Content-Type. Before streaming, failures return JSON `{error:{code,message,retryable},runId?}`; 429 includes Retry-After. Once streaming begins, failures use terminal events rather than another HTTP status.

Run responses include ID, status, fixed address/version/scope, result, and error. Results contain text, final/partial/unavailable status, cards, sources, coverage, warnings, and ordered activity. Terminal results come from storage, not reconstructed client deltas.

SSE includes `run.started`, `tool.preparing`, `tool.started`, `tool.completed`, `message.delta`, `message.round.completed`, `message.completed`, `run.failed`, and `run.interrupted`. Events carry run ID; tools carry call IDs and status. Completion includes committed results; failures/interruption include error and available results. Text phases distinguish intermediate explanation from final answer. Heartbeats run every fifteen seconds; disable proxy buffering and allow at least 75 seconds. Use fetch and incremental stream decoding for POST SSE, including split bytes and event boundaries.

### State and transactions

| From | Trigger | Result |
| --- | --- | --- |
| No run | Authentication, version, quota checks pass | Atomically create user message, running run, and reservation. |
| Running | Grounded answer completes, possibly with partial tool coverage | Completed with saved text, cards, sources, and explicit coverage. |
| Running | Disconnect, cancellation, or restart | Interrupted with saved snapshots and partial/unavailable text. |
| Running | Timeout, model failure, or unavailable evidence | Failed with saved results and an explicit error. |
| Terminal | Late callbacks or duplicate requests | No overwrite, additional output, or second settlement. |

There is no event replay or background continuation. Abort tools and model on disconnect. Shared upstream queries cancel only when no subscribers remain. Save tool snapshots before completion events; checkpoint text every second or 1,000 characters. A restart may lose the last uncommitted delta. Partial answers are not later treated as final conclusions.

Terminal writes use `WHERE status='running'` and commit the assistant message, result, and quota settlement in one transaction before emitting completion. Startup interrupts and settles orphaned running requests before accepting traffic. Reconnect retrieves the saved run. An uncertain POST reuses its original ID; explicit retry creates a new one.

Request IDs are unique within a conversation. Hash normalized schema-validated text, expected address version, and contract version. The fixed address lives on the run; do not recompute its hash from a subsequently changed conversation. Duplicate lookup follows authentication/ownership and precedes new-request version, quota, and concurrency checks. Enforce one running request per conversation transactionally.

Use six tables: users, sessions, conversations, messages, runs, and tool_calls. Conversations store address/version; messages link runs and addresses and distinguish partial/final text. Runs store request identity/hash, fixed scope, result, provider/model/versions, usage, quota day, reservation, settlement, and errors. Tool calls store inputs, versions, snapshots, and source times. Enable foreign keys, unique request IDs, a partial unique index for running conversation requests, and at most one assistant message per run. Use WAL, busy timeout, short write transactions, and no network operations inside transactions. Back up through SQLite's online API rather than copying an active main file without WAL.

Track daily quotas in `Asia/Shanghai`. Sum actual settled usage and unresolved reservations atomically before accepting new work. Running requests count toward user request limits. Settle once, charge uncertain usage conservatively, and charge the full reservation on restart when usage is lost. Duplicate requests do not reserve again; explicit retries count as new requests. Never prune data still required for the current quota day.

## Validation, operations, and later phases

The original delivery estimate was two to three weeks with one backend and one frontend engineer, subject to API and integration verification. Sequence the work as authentication/storage/chat, tools and risk, model/SSE/cards, then limits/recovery/backups. Validate isolation and deduplication first, account and failure fixtures next, then end-to-end tasks and operations.

The [acceptance checklist](acceptance.md) contains twenty live evaluations and release gates. Automated boundary tests also cover null/negative liquidation distance, empty accounts and nonpositive equity, unsupported modes, role/mode failures, agent/vault/missing addresses, failed orders, tied fill timestamps, mixed-market cursor progress, truncation direction, unknown retention, account changes, duplicate/conflicting IDs, disconnects around commit, restart settlement, isolation, and SSE chunking. Twenty live examples alone are not sufficient coverage.

All important numbers need sources; unknowns remain unknown; scope stays visible; funds cannot be changed. Allow ten concurrent runs globally and return 429 above that limit. Target common responses within thirty seconds, with explicit timeout feedback. Record tokens, latency, tool success, and cache hits; verify provider cost/limits before trial access.

Retain chats, runs, and snapshots for thirty days. Explicit conversation deletion rejects active runs, clears chat content and addresses atomically, and makes the conversation and runs inaccessible. Keep redacted run accounting through normal retention to preserve daily quotas. Idempotency is limited to retention; clients must not replay expired requests. Retain redacted logs for seven days, with no raw chats, full addresses, cookies, or tool responses. Take encrypted daily backups, restricted to administrators and retained for seven days. Explain that backups may retain expired data for seven additional days. Target 24-hour RPO and four-hour RTO. Before release, restore into an independent database and verify message/source links, quotas, and terminal states. Real account semantics, sorting, and units require verified fixtures; otherwise use the documented fallback.

NOFX is a reference for Hyperliquid queries, field differences, order status, and authorization boundaries, not a runtime dependency. Do not import its automatic trading loop, exchange abstraction, model-payment wallet, or generic REST agent.

Add markets and account modes only when needed; introduce WebSocket for demonstrated real-time requirements. User-confirmed trading needs a separate execution module with explicit action, account, quantity, limit price, reduce-only flag, expiry, and confirmation record using Hyperliquid's signing protocol. Base swap calldata/approval flows do not apply. Automatic trading later needs independent agent authorization, limits, and pause controls. The model never receives direct funds access. Avoid empty modules for speculative chains, research, background jobs, or model providers.
