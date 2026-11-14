# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | yes       |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately through GitHub's **Report a vulnerability** button under the repository's
Security tab (private vulnerability reporting). Include:

- a description of the issue and its impact
- steps to reproduce, or a proof of concept
- the affected version or commit

You will get an acknowledgement within 7 days. A fix or mitigation plan will follow once the report is confirmed.

## Scope

Issues of particular interest:

- authentication bypass or timing leaks in the admin API
- open redirects through placeholder substitution
- regular expression denial of service that gets past the safety checks
- validation bypasses that let loops or unsafe destinations be saved

## Deployment hardening

- Use a random `ADMIN_TOKEN` of at least 32 characters (`openssl rand -hex 32`), set with `wrangler secret put`.
- Consider protecting `ADMIN_PATH` with Cloudflare Access, or skip the API and use `wrangler kv bulk put`.
- Keep `ENABLE_REGEX` off unless you need it.
