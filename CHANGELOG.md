# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-14

### Added

- Cloudflare Worker that serves redirects from a rule set stored in Workers KV or D1, with an in-isolate compiled router cache.
- Rule types: exact (including query-qualified sources), prefix/wildcard with `$n`, `:name` and `:splat` captures, and opt-in regex with safety checks, an input cap and a per-request time budget.
- 301/302/307/308 status codes, query `preserve`/`strip`, UTM appending, `startsAt`/`expiresAt` scheduling, host scoping, case sensitivity and an enabled flag.
- Validator for loops, chains, conflicts, duplicates, invalid status codes, unsafe destinations, unknown placeholders, unsafe regex and invalid dates.
- CSV (RFC 4180) and JSON import/export, plus `wrangler kv bulk put` file generation.
- Click counting via Workers Analytics Engine or KV counters.
- Admin API protected by a bearer token compared in constant time.
- CLI: `validate`, `import`, `export`, `test` (with `--cases` assertions) and `diff`.
- CI on Node 20/22/24 and a GitHub Packages publish workflow.

[0.1.0]: https://github.com/saizul/cf-worker-redirects/releases/tag/v0.1.0
