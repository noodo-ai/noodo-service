# Engineering conventions

This document is the source of truth for repository engineering rules. [AGENTS.md](../AGENTS.md) points coding agents here. The optional `noodo-service-engineering` skill provides a review and refactoring workflow; it reads these rules rather than keeping a second copy.

Keep the code easy to follow before making it generic. Extract a module when it owns a clear behavior, not simply because a file exceeds an arbitrary line count.

## Responsibility boundaries

- `server.ts` constructs dependencies and owns service startup/shutdown.
- `http/` handles authentication, validation, rate limits, routes, and SSE delivery.
- `ai/runner.ts` coordinates a bounded run. `model-context.ts` prepares model input and budgets; `run-progress.ts` persists and streams progress; `provider.ts` adapts the SDK.
- `hyperliquid/tools.ts` validates and dispatches the three public tools. `market.ts`, `account.ts`, and `fills.ts` own their queries. `client.ts` owns transport/cache/retries, and `risk.ts` owns pure calculations.
- `db/` owns schema, migrations, persistence, and transaction boundaries. Keep atomic acceptance and settlement together; do not split a transaction for cosmetic file-size goals.

Prefer explicit parameters, domain names, and typed boundaries. Avoid generic service/repository base classes, unnecessary interfaces, catch-all utilities, and forwarding layers. Extract shared code only when multiple callers have the same requirement. Use English comments and documentation; explain why a constraint exists rather than paraphrasing the next line.

## Correctness

Validate unknown input at HTTP, provider, upstream, and persistence boundaries. Keep decimal values and large external IDs as strings. Never replace missing financial data with zero. Carry source and coverage information through transformations.

Preserve request IDs and transaction boundaries when refactoring. Never await network work inside SQLite write transactions. Finalization must remain conditional and idempotent. Propagate cancellation and clean up timers/listeners. Return known public errors without exposing secrets or provider payloads.

Use the repository's Node 22 wrapper for lint, typecheck, tests, and build so validation uses the same native dependencies as runtime. Run all four checks before handing off changes. Add regression tests for bugs and meaningful tests for extracted behavior; avoid tests that only repeat implementation details.

## Formatting and review

Use the existing Prettier configuration and TypeScript/ESLint rules. Prefer one declaration per statement for unrelated variables. Keep public function inputs explicit. During review, check ownership, failure paths, cleanup, time/token limits, source coverage, and meaningful naming before cosmetic changes.

External references to evaluate include [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices) and [Vercel Agent Skills](https://github.com/vercel-labs/agent-skills). Their current content, popularity, and suitability were not verified during this review because external access failed. No third-party skill or dependency was installed. Adopt specific guidance only after reviewing it against this project's Fastify/SQLite and React/Vite architecture.
