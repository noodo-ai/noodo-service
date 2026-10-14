# Noodo service

Before changing service code, read [docs/engineering.md](docs/engineering.md). It is the source of truth for repository engineering conventions.

For requested code reviews, use the shared `noodo-review` skill when available. It owns scope selection, independent review passes, evidence, and reporting; repository rules remain in the engineering document. If unavailable, review against these sources directly, include requirements and runtime correctness, and report the scope and verification limits.

For backend reviews and structural refactoring, also use `noodo-service-engineering` when available for domain and lifecycle guidance. If it is unavailable, follow the repository conventions directly; do not block the task on installing a skill.

Keep project rules in the engineering document and reusable workflow guidance in the skill. Update the relevant document when an intentional architecture change makes it stale.
