# Contributing

Thanks for your interest in improving cf-worker-redirects.

## Development setup

```bash
git clone https://github.com/saizul/cf-worker-redirects.git
cd cf-worker-redirects
npm ci
npm test
```

- `npm run lint`: type check
- `npm test`: build, then run `node --test dist/test/*.test.js`
- `npm run dev`: local Worker via `wrangler dev` (copy `.dev.vars.example` to `.dev.vars` first)

## Guidelines

- Keep the routing core (`src/router.ts`, `src/pattern.ts`, `src/validate.ts`, `src/io.ts`) free of Workers-only APIs, so it stays testable on plain Node.js.
- Every behaviour change needs a test. Bug fixes should come with a test that fails without the fix.
- New validator checks need a stable `code` string, and the README table must be updated.
- Do not add runtime dependencies without discussing it first in an issue.
- Use clear commit messages, and add an entry to `CHANGELOG.md` under "Unreleased".

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change with tests.
3. Run `npm run lint && npm test`.
4. Open a pull request that describes the problem and the solution.

By contributing, you agree that your contributions are licensed under the MIT License.
