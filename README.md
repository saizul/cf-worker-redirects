# cf-worker-redirects

[![CI](https://github.com/saizul/cf-worker-redirects/actions/workflows/ci.yml/badge.svg)](https://github.com/saizul/cf-worker-redirects/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Bulk redirects and short links on **Cloudflare Workers**, with the rules kept in **Workers KV** (or **D1**).
You import rules from CSV or JSON. A validator catches loops, chains, conflicts and bad status codes
before anything goes live. Clicks can be counted with **Workers Analytics Engine**. A bearer-token admin
API and a CLI (`npx cf-worker-redirects import|export|test|diff|validate`) handle day-to-day changes.

Use it for site migrations (thousands of legacy URLs), domain moves, vanity and QR short links,
campaign links with UTM tags, and temporary or scheduled redirects.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Install](#install)
- [Install from GitHub Packages](#install-from-github-packages)
- [Deploy](#deploy)
- [Rule format](#rule-format)
- [CLI usage](#cli-usage)
- [Admin API](#admin-api)
- [Configuration](#configuration)
- [Click analytics](#click-analytics)
- [Examples](#examples)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Limitations](#limitations)
- [License](#license)

## Features

- **Rule types**
  - `exact`: `/old-page`, plus query-qualified sources such as `/index.php?p=42`
  - `prefix` / wildcard: `/blog/*`, `/docs/:version/*`, or a bare sub-tree `/shop`, with captures (`$1`, `:name`, `:splat`)
  - `regex` (opt-in): `^/p/(?<id>\d+)$` with `$1` / `$<id>`, behind static safety checks, an input length cap and a per-request time budget
- **Status codes** 301, 302, 307 and 308. Anything else is rejected.
- **Query strings**: `preserve` (default; incoming parameters are merged into the destination) or `strip`
- **UTM tagging**: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` and `utm_id` are added to the destination unless already present
- **Scheduling**: per-rule `startsAt` / `expiresAt`, plus an `enabled` flag
- **Host scoping**: limit a rule to `go.example.com` or `*.example.com`
- **Validator** (`validate`, and automatically on every import or save):
  - redirect **loops** (A → A, A → B → A, and prefix rewrites that grow forever), detected by running the real router
  - redirect **chains** (A → B → C), reported along with the final hop to point at directly
  - **conflicting** rules (same source, different target) and exact duplicates
  - invalid status codes, types, query modes, hosts and dates
  - unsafe destinations (`javascript:`, protocol-relative `//host`, control characters)
  - placeholders the source does not capture (`$3` with two captures)
  - catastrophic-backtracking regex (`(a+)+`, `(a|aa)*`, backreferences)
  - expired rules, and permanent redirects that carry an expiry
- **Storage**: one JSON document in KV (default) or a single D1 row. Each isolate caches the compiled router, so most requests do no storage read at all.
- **Click counting**: Analytics Engine (recommended) or simple KV counters
- **Admin API**: bearer token, compared in constant time over SHA-256 digests. It fails closed if the token is missing or shorter than 32 characters.
- **CLI**: talks to the admin API, or writes a bulk file for `wrangler kv bulk put` so you never need to expose the API at all

## How it works

```
request ──► Worker ──► in-isolate cache (compiled Router, TTL = CACHE_TTL)
                          │ miss
                          ▼
                    KV "ruleset:v1"  (or D1 row)
Router.match():
  1. exact table (O(1) map lookup, query-qualified sources first)
  2. prefix rules, most specific (longest literal prefix) first
  3. regex rules, in order, under an input cap and time budget
match  ──► 301/302/307/308 + Location, click recorded via ctx.waitUntil
no match ─► 404, a pass-through to origin, or a fixed fallback URL
```

The admin API lives under `ADMIN_PATH` (default `/__redirects`) on the same Worker.

## Install

Requirements: Node.js 20 or newer and a Cloudflare account.

```bash
git clone https://github.com/saizul/cf-worker-redirects.git
cd cf-worker-redirects
npm ci
npm test
```

You can run the CLI without cloning:

```bash
npx cf-worker-redirects --help
```

## Install from GitHub Packages

Each GitHub release also publishes the package to GitHub Packages as `@saizul/cf-worker-redirects`.

1. Create a GitHub personal access token (classic) with the `read:packages` scope.
2. Point the `@saizul` scope at GitHub Packages, in `~/.npmrc` or a project `.npmrc`:

   ```ini
   @saizul:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

   Export `GITHUB_TOKEN` in your shell. Do not paste the token into the file.
3. Install and run it:

   ```bash
   npm install --save-dev @saizul/cf-worker-redirects
   npx cf-worker-redirects validate redirects.csv
   ```

The package also exports the routing core (`Router`, `validateRules`, `parseCsv`, `toKvBulk`, and others), so you can use it inside your own Worker.

## Deploy

```bash
# 1. Create the KV namespace and paste the id into wrangler.jsonc
npx wrangler kv namespace create REDIRECTS

# 2. Set the admin token (a secret, never a var)
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN

# 3. Add a route or custom domain in wrangler.jsonc, then deploy
npx wrangler deploy

# 4. Load rules: either through the admin API...
export CFWR_ADMIN_TOKEN=...            # same value as ADMIN_TOKEN
npx cf-worker-redirects import examples/redirects.csv --api https://go.example.com

# ...or without the API, through wrangler:
npx cf-worker-redirects import examples/redirects.csv --kv-bulk kv-bulk.json
npx wrangler kv bulk put kv-bulk.json --binding REDIRECTS --remote
```

Configuration lives in `wrangler.jsonc`, which Cloudflare recommends for new projects.
To store rules in D1 instead of KV, uncomment the `d1_databases` block, set `STORAGE` to `d1` and run:

```bash
npx wrangler d1 create cf-worker-redirects
npx wrangler d1 migrations apply cf-worker-redirects --remote
```

For local development, copy `.dev.vars.example` to `.dev.vars`, set `ADMIN_TOKEN` and run `npm run dev`.

## Rule format

| Field           | Required | Default    | Notes |
|-----------------|----------|------------|-------|
| `source`        | yes      |            | Alias `from`. A path that starts with `/`, or a regex for `type: regex` |
| `destination`   | yes      |            | Alias `to`. An absolute `http(s)://` URL or a path that starts with `/` |
| `type`          | no       | inferred   | `exact`, `prefix` or `regex`. A source with `*` or `:name` is treated as prefix, and one starting with `^` or ending with `$` as regex |
| `status`        | no       | `301`      | Alias `code`. One of `301`, `302`, `307`, `308` |
| `id`            | no       | hash       | Stable id, derived from type, host and source when omitted |
| `host`          | no       | any        | `example.com` or `*.example.com` |
| `query`         | no       | `preserve` | `preserve` or `strip` |
| `utm_*` / `utm` | no       |            | CSV columns `utm_source` and so on, or a JSON `utm` object |
| `startsAt`      | no       |            | ISO-8601. The rule is inactive before this time |
| `expiresAt`     | no       |            | ISO-8601. The rule is inactive from this time on |
| `caseSensitive` | no       | `false`    | Path case sensitivity |
| `enabled`       | no       | `true`     | `true/false/yes/no/1/0` |
| `note`          | no       |            | Free text |

Placeholders in `destination`:

| Placeholder        | Meaning |
|--------------------|---------|
| `$1` … `$99`       | Positional captures: wildcards and `:params` for prefix rules, groups for regex |
| `:name`            | A named `:param` from a prefix source. `:splat` is the last wildcard |
| `$<name>`          | A named group (regex) or a named param |
| `$$`               | A literal `$` |

Matching details:

- Exact paths ignore case and trailing slashes by default (`/About/` matches `/about`). Percent-encoded and decoded forms match each other.
- `/blog/*` matches `/blog`, `/blog/` and everything below it. A prefix source without a wildcard (`/shop`) matches the sub-tree.
- With several prefix rules, the one with the longest literal prefix wins, whatever order the rules are in.
- A rule whose substituted destination would become unsafe (`/go//evil.com` → `//evil.com`) is skipped at runtime.

CSV example (header row required; a header-less `source,destination[,status]` file is also accepted):

```csv
source,destination,status,query,expiresAt,utm_source,utm_campaign
/about-us,/about,301,,,,
/news/*,/blog/$1,301,,,,
/sale,https://shop.example.com/spring,302,strip,2027-04-01T00:00:00Z,website,spring
```

## CLI usage

```
cf-worker-redirects validate <file> [--allow-regex] [--internal-host <host>...] [--json]
cf-worker-redirects import <file> --api <url> [--mode replace|merge] [--dry-run] [--force]
cf-worker-redirects import <file> --kv-bulk <out.json>
cf-worker-redirects export --api <url> [--format json|csv] [--out <file>]
cf-worker-redirects export --from <file> [--format json|csv] [--out <file>]
cf-worker-redirects test <file> <url>...            # match locally
cf-worker-redirects test <file> --cases cases.json  # assertions, exit 1 on failure
cf-worker-redirects test --api <url> <url>...       # ask the deployed Worker
cf-worker-redirects diff <file> --api <url>         # local file vs deployed rules
cf-worker-redirects diff <file> --against <other>
```

- The token is read from `CFWR_ADMIN_TOKEN`, and `CFWR_API` can replace `--api`.
- `import` refuses files with errors. It also refuses files with warnings (chains, expired rules) unless you pass `--force` or `--dry-run`.
- `--internal-host www.example.com` tells the validator that absolute URLs on that host point back at the same site, so loops through them are caught. The Worker always adds its own hostname.
- Exit codes: `0` success, `1` validation, test or diff differences, `2` usage error.

Use `test --cases` in CI, so a pull request that changes `redirects.csv` must keep the important URLs working:

```json
[
  { "url": "https://example.com/about-us", "status": 301, "location": "/about" },
  { "url": "https://example.com/not-a-rule", "location": null }
]
```

## Admin API

Every endpoint except `/health` needs `Authorization: Bearer $ADMIN_TOKEN`.

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/__redirects/health` | `{ok, storage, rules, updatedAt}`, no auth |
| GET    | `/__redirects/api/rules` | Current rule set |
| PUT    | `/__redirects/api/rules` | Replace everything (`[...]` or `{rules:[...]}`) |
| POST   | `/__redirects/api/rules` | Upsert by id (one rule or a list) |
| GET    | `/__redirects/api/rules/:id` | One rule |
| DELETE | `/__redirects/api/rules/:id` | Delete one rule |
| POST   | `/__redirects/api/import?format=csv\|json&mode=replace\|merge&dryRun=1` | Raw CSV or JSON body |
| GET    | `/__redirects/api/export?format=json\|csv` | Download |
| POST   | `/__redirects/api/validate` | Validate without saving |
| GET    | `/__redirects/api/test?url=/path` | Which rule matches, and where it goes |
| GET    | `/__redirects/api/stats[?ids=a,b]` | KV click counters |

Writes that fail validation return `422` with the full report, and nothing is saved. `?dryRun=1` validates and reports without saving.

```bash
curl -fsS -X POST "https://go.example.com/__redirects/api/import?format=csv&mode=merge" \
  -H "Authorization: Bearer $CFWR_ADMIN_TOKEN" -H "content-type: text/csv" \
  --data-binary @examples/short-links.csv
```

## Configuration

All settings are `vars` in `wrangler.jsonc`, except `ADMIN_TOKEN`, which is a secret.

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_TOKEN` | (none) | **Secret**, at least 32 characters. Without it the admin API returns 503 |
| `ADMIN_PATH` | `/__redirects` | Prefix for the admin API |
| `STORAGE` | `kv` | `kv` (binding `REDIRECTS`) or `d1` (binding `DB`) |
| `COUNTER` | `none` | `none`, `analytics` (binding `CLICKS`) or `kv` |
| `ENABLE_REGEX` | `false` | Allow regex rules |
| `REGEX_BUDGET_MS` | `5` | Per-request time budget across regex rules (1 to 50) |
| `FALLBACK` | `404` | `404`, `passthrough` (forward to origin when deployed on a route) or `redirect` |
| `FALLBACK_URL` | (none) | Target for `FALLBACK=redirect` (sent as a 302) |
| `CACHE_TTL` | `60` | Seconds a compiled rule set is reused per isolate. Also used as the KV `cacheTtl`, which has a minimum of 30 |
| `INTERNAL_HOSTS` | (none) | Comma-separated hosts treated as this site during loop detection |
| `MAX_RULES` | `50000` | Upper limit for one rule set |

Response headers: permanent redirects send `cache-control: public, max-age=3600`, so a mistake does not
live in browsers forever. Temporary redirects send `no-store`.

## Click analytics

With `COUNTER=analytics` and the `CLICKS` binding enabled, each redirect writes one data point:

| Field | Value |
|-------|-------|
| index1 | rule id |
| blob1 … blob7 | rule id, host, path, location, status, country, referrer host |
| double1 | `1` |

Query the data with the Analytics Engine SQL API. See [`examples/clicks.sql`](examples/clicks.sql) and
[`examples/query-clicks.sh`](examples/query-clicks.sh). `COUNTER=kv` keeps a `clicks:<id>` key per rule,
readable through `/api/stats`. It is only meant for low traffic (see the limitations).

## Examples

- [`examples/redirects.csv`](examples/redirects.csv): a site migration with exact, query-qualified, prefix, parameter and scheduled rules
- [`examples/short-links.csv`](examples/short-links.csv): vanity and QR short links with UTM tags
- [`examples/redirects.json`](examples/redirects.json): a JSON format with regex and host-scoped rules
- [`examples/cases.json`](examples/cases.json): CLI test cases for CI

```bash
npx cf-worker-redirects test examples/redirects.csv --cases examples/cases.json
npx cf-worker-redirects validate examples/redirects.json --allow-regex
```

## Testing

```bash
npm ci
npm test          # tsc build, then: node --test dist/test/*.test.js
npm run lint      # type check only
```

The tests run on plain Node.js with `node:test`. They need no Cloudflare login and no `workerd`. The routing
core is made of pure functions, and the Worker handler is tested end to end against in-memory KV, D1 and
Analytics Engine doubles (`test/helpers.ts`). The CLI tests send their `fetch` calls straight into an
in-memory Worker, so import, export, diff and test-against-API run as real round trips. CI runs the suite on
Node 20, 22 and 24, checks the example files with the CLI, and bundles the Worker with `wrangler deploy --dry-run`.

## Security notes

- **The admin token is the only credential.** Generate it with `openssl rand -hex 32` and store it with `wrangler secret put`. The Worker refuses admin requests when the token is unset or shorter than 32 characters.
- The token is checked in constant time over SHA-256 digests, so neither its content nor its length leaks through timing.
- Prefer the `--kv-bulk` + `wrangler kv bulk put` path if you do not want an admin API on the internet. You can also put `ADMIN_PATH` behind Cloudflare Access.
- Destinations must be `http(s)` URLs or site-relative paths. `javascript:`, `data:`, protocol-relative and control-character destinations are rejected at validation time, and checked again after placeholder substitution at runtime, which blocks open-redirect tricks through captures.
- Regex rules are off by default. When enabled, they go through static safety checks, an input length cap and a time budget.
- Rule sets that fail validation are never saved.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Limitations

- **One document per rule set.** KV values are capped at 25 MiB (about 100k typical rules). Every write replaces the whole document, so concurrent admin writes are last-writer-wins.
- **Propagation delay.** KV is eventually consistent. Other locations and isolates pick up changes after `CACHE_TTL` plus KV's own edge cache, typically within about a minute. The isolate that handled the write sees it at once.
- **Regex time budget.** JavaScript regular expressions cannot be interrupted. The "timeout" is a budget checked *between* regex rules, so it relies on the static checks to keep each single match fast. It is not a hard per-match deadline.
- **KV counters** are read-modify-write (not atomic) and KV allows about one write per second per key. Counts are approximate under load. Use Analytics Engine for real traffic.
- Loop detection follows only same-site destinations: relative paths, the Worker's own host and `INTERNAL_HOSTS`. Regex sources cannot be inverted, so loops that *start* at a regex rule are not detected.
- Prefix patterns match against the raw (percent-encoded) path. Exact rules compare decoded paths.
- For very simple static lists, Cloudflare's built-in Bulk Redirects may be enough. This project is for when you need captures, scheduling, UTM, analytics, validation or an API.

## License

[MIT](LICENSE) © 2026 Saizul Amin
