# MVP evaluation and release checklist

Unchecked items are incomplete. Automated tests verify code behavior; live providers, account modes, and deployment require separate evidence.

## Twenty live Claude evaluations

Configure an API key, create an invited user, and start the service and frontend. The model is fixed to `claude-sonnet-4-6`. Use known public main-account or subaccount addresses. Check values, sources, coverage, tool selection, and explanations against actual query snapshots. Record the actual model, timestamp, tokens, latency, outcome, and error codes. Obtain pricing and RPM/TPM limits from the account console, not a web subscription.

| # | Category | Input or condition | Pass criteria | Result |
| --- | --- | --- | --- | --- |
| 1 | Market | BTC mark price, funding, OI | Fields, units, hourly rate, and sources agree. | Pending |
| 2 | Market | ETH 24h volume | `dayNtlVlm` is USD notional, not underlying units. | Pending |
| 3 | Market | HYPE OI in USD | Uses the same response's mark price and labels the estimate. | Pending |
| 4 | Market | BTC 1h candles over 24h | Bounded count; record time is distinct from snapshot time. | Pending |
| 5 | Market | BTCUSDT or a non-default DEX asset | Rejects unsupported names without guessing aliases. | Pending |
| 6 | Account | Main-account positions | One market query; correct direction, margin mode, and raw liquidation price. | Pending |
| 7 | Account | A specific subaccount | Only the selected address; no main-account aggregation. | Pending |
| 8 | Account | Agent or vault address | Reports unsupported scope without following another address. | Pending |
| 9 | Account | Missing or empty account | Distinguishes missing data from verified empty positions; no invented zero balance. | Pending |
| 10 | Account | Default, unified, portfolio, or unknown mode | Raw positions remain; balances and derived risk are hidden. | Pending |
| 11 | Risk | Verified disabled-mode long and short positions | Consistent margin summary; correct direction formulas and concentration. | Pending |
| 12 | Risk | Null or negative liquidation distance | Unknown or needs verification; missing data first; no safety score. | Pending |
| 13 | Risk | Ordinary reduce-only and stop orders | Checks order type, trigger direction, and query status; no full-protection claim. | Pending |
| 14 | Fills | Last seven days | Latest available sample, stable order, fee currencies; no complete PnL claim. | Pending |
| 15 | Fills | Historical interval, truncation, mixed markets | Advances using raw pages; partial history; retention remains unverified. | Pending |
| 16 | Access | Account question with no selected address | Requests explicit selection; market queries remain available. | Pending |
| 17 | Access | Change address, trade, or cancel through chat | Does not change the account or trade; explains scope and account selection. | Pending |
| 18 | Failure | Order/mode failure or stale prices | Keeps raw positions, marks unknowns, disables affected derived metrics. | Pending |
| 19 | Failure | Claude count/generation failure or 429 | Explicit error; cards saved; no fabricated completion or generation retry. | Pending |
| 20 | Access/recovery | Another user's run; disconnect or duplicate | 404 isolation; original ID is not charged twice; partial/terminal results saved. | Pending |

## Trial gates

- [ ] Record the Claude account, model access, pricing, and rate limits without recording the key.
- [ ] Verify real `disabled` account balances and risk semantics. Record query sources and times before enabling `SUPPORTED_ACCOUNT_MODES=disabled`.
- [ ] Pass all twenty evaluations. Target under thirty seconds for common requests; explain timeouts and cost.
- [ ] Verify browser sign-in/out, history, account-version conflicts, consecutive sends, SSE, cancellation, recovery, new-ID retries, keyboard access, and 1440/834/390 layouts.
- [ ] Use same-origin HTTPS, Secure cookies, an Origin allowlist, persistent SQLite, and a single service instance.
- [ ] Verify unbuffered SSE, fifteen-second heartbeats, and at least a 75-second timeout through the real proxy.
- [ ] Configure daily encrypted backups and log rotation, separate key storage, and seven-day retention.
- [ ] Restore to an independent database; measure RPO/RTO and verify messages, sources, terminal states, and quotas.
- [ ] Disclose thirty-day chat retention, up to seven additional backup days, and that an observed address does not prove ownership.
