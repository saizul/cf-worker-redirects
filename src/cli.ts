/**
 * cf-worker-redirects CLI.
 *
 *   cf-worker-redirects validate <file>
 *   cf-worker-redirects import   <file> (--api <url> | --kv-bulk <out.json>) [--mode replace|merge] [--dry-run]
 *   cf-worker-redirects export   (--api <url> | --from <file>) [--format json|csv] [--out <file>]
 *   cf-worker-redirects test     (<file> | --api <url>) <url...> | --cases <cases.json>
 *   cf-worker-redirects diff     <file> (--api <url> | --against <file>)
 *
 * The admin token is read from the CFWR_ADMIN_TOKEN environment variable.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { diffRules, parseRules, toCsv, toKvBulk, type RuleDiff } from "./io.js";
import { Router } from "./router.js";
import type { Rule, RuleSetDocument } from "./types.js";
import { formatReport, validateRules, type ValidationReport } from "./validate.js";

export const VERSION = "0.1.0";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  now: () => number;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  env: process.env,
  fetch: (...args) => fetch(...args),
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, d) => writeFileSync(p, d),
  now: () => Date.now(),
};

const HELP = `cf-worker-redirects ${VERSION}

Usage:
  cf-worker-redirects validate <file> [--allow-regex] [--internal-host <host>...] [--json]
  cf-worker-redirects import <file> --api <url> [--mode replace|merge] [--dry-run]
  cf-worker-redirects import <file> --kv-bulk <out.json>
  cf-worker-redirects export --api <url> [--format json|csv] [--out <file>]
  cf-worker-redirects export --from <file> [--format json|csv] [--out <file>]
  cf-worker-redirects test <file> <url> [<url>...]
  cf-worker-redirects test <file> --cases <cases.json>
  cf-worker-redirects test --api <url> <url>...
  cf-worker-redirects diff <file> --api <url>
  cf-worker-redirects diff <file> --against <other-file>

Options:
  --api <url>            Worker base URL, for example https://go.example.com
  --admin-path <path>    Admin prefix on the Worker (default /__redirects)
  --allow-regex          Accept regex rules (must also be enabled on the Worker)
  --internal-host <h>    Host treated as "this site" for loop detection (repeatable)
  --force                Import even when the validator reports warnings
  --json                 Machine-readable output

Environment:
  CFWR_ADMIN_TOKEN       Bearer token for the admin API
  CFWR_API               Default for --api
`;

class CliError extends Error {
  constructor(
    message: string,
    public readonly code = 1,
  ) {
    super(message);
  }
}

function loadRules(io: CliIO, file: string): Rule[] {
  let text: string;
  try {
    text = io.readFile(file);
  } catch (e) {
    throw new CliError(`cannot read ${file}: ${(e as Error).message}`);
  }
  const parsed = parseRules(text, file);
  if (parsed.errors.length) {
    throw new CliError(`${file}: ${parsed.errors.length} invalid row(s)\n  ${parsed.errors.map((e) => e.message).join("\n  ")}`);
  }
  return parsed.rules;
}

function apiBase(api: string, adminPath: string): string {
  const base = api.replace(/\/+$/, "");
  const p = adminPath.startsWith("/") ? adminPath : `/${adminPath}`;
  return `${base}${p.replace(/\/+$/, "")}`;
}

async function callApi(
  io: CliIO,
  base: string,
  path: string,
  init: { method?: string; body?: string; contentType?: string } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const token = io.env.CFWR_ADMIN_TOKEN;
  if (!token) throw new CliError("CFWR_ADMIN_TOKEN is not set");
  const res = await io.fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": init.contentType ?? "application/json" } : {}),
      "user-agent": `cf-worker-redirects-cli/${VERSION}`,
    },
    body: init.body,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // CSV or plain text
  }
  if (res.status === 401 || res.status === 503) {
    throw new CliError(`admin API refused the request (${res.status}): ${(body as { error?: string }).error ?? text}`);
  }
  return { status: res.status, body, text };
}

function summarizeDiff(d: RuleDiff): string {
  const lines: string[] = [];
  for (const r of d.added) lines.push(`+ ${r.id}  ${r.source} -> ${r.destination} (${r.status})`);
  for (const r of d.removed) lines.push(`- ${r.id}  ${r.source} -> ${r.destination} (${r.status})`);
  for (const c of d.changed) {
    lines.push(`~ ${c.after.id}  ${c.fields.join(", ")}`);
    for (const f of c.fields) {
      lines.push(
        `    ${f}: ${JSON.stringify(c.before[f] ?? null)} -> ${JSON.stringify(c.after[f] ?? null)}`,
      );
    }
  }
  lines.push(`${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.unchanged} unchanged`);
  return lines.join("\n");
}

interface TestCase {
  url: string;
  location?: string | null;
  status?: number;
}

export async function run(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        api: { type: "string" },
        "admin-path": { type: "string", default: "/__redirects" },
        "allow-regex": { type: "boolean", default: false },
        "internal-host": { type: "string", multiple: true },
        "kv-bulk": { type: "string" },
        mode: { type: "string", default: "replace" },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        format: { type: "string" },
        out: { type: "string" },
        from: { type: "string" },
        against: { type: "string" },
        cases: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (e) {
    io.err((e as Error).message);
    io.err(HELP);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (opts.version) {
    io.out(VERSION);
    return 0;
  }
  if (opts.help || !command) {
    io.out(HELP);
    return command || opts.help ? 0 : 2;
  }

  const api = opts.api ?? io.env.CFWR_API;
  const base = api ? apiBase(api, opts["admin-path"] ?? "/__redirects") : undefined;
  const vopts = {
    allowRegex: opts["allow-regex"],
    internalHosts: opts["internal-host"] ?? [],
    now: io.now(),
  };
  const printReport = (report: ValidationReport) => {
    if (opts.json) io.out(JSON.stringify(report, null, 2));
    else io.out(formatReport(report));
  };

  try {
    switch (command) {
      case "validate": {
        const file = rest[0];
        if (!file) throw new CliError("validate: missing <file>", 2);
        const report = validateRules(loadRules(io, file), vopts);
        printReport(report);
        return report.ok ? 0 : 1;
      }

      case "import": {
        const file = rest[0];
        if (!file) throw new CliError("import: missing <file>", 2);
        if (!opts["kv-bulk"] && !base) throw new CliError("import: pass --api <url> or --kv-bulk <out.json>", 2);
        const rules = loadRules(io, file);
        const report = validateRules(rules, vopts);
        if (!report.ok || (report.warnings > 0 && !opts.force && !opts["dry-run"])) {
          printReport(report);
          if (!report.ok) throw new CliError("import aborted: fix the errors above");
          throw new CliError("import aborted: warnings present (use --force to import anyway)");
        }
        if (opts["kv-bulk"]) {
          io.writeFile(opts["kv-bulk"], JSON.stringify(toKvBulk(rules, new Date(io.now())), null, 2) + "\n");
          io.out(`wrote ${rules.length} rule(s) to ${opts["kv-bulk"]}`);
          io.out(`next: npx wrangler kv bulk put ${opts["kv-bulk"]} --binding REDIRECTS --remote`);
          return 0;
        }
        if (!base) throw new CliError("import: pass --api <url> or --kv-bulk <out.json>", 2);
        const mode = opts.mode === "merge" ? "merge" : "replace";
        const res = await callApi(
          io,
          base,
          `/api/import?format=json&mode=${mode}${opts["dry-run"] ? "&dryRun=1" : ""}`,
          { method: "POST", body: JSON.stringify({ rules }) },
        );
        if (res.status >= 300) {
          io.err(JSON.stringify(res.body, null, 2));
          throw new CliError(`import failed with HTTP ${res.status}`);
        }
        const b = res.body as { saved?: boolean; count?: number; dryRun?: boolean };
        io.out(b.dryRun ? `dry run OK: ${b.count} rule(s) would be saved` : `imported ${b.count} rule(s)`);
        return 0;
      }

      case "export": {
        const format = opts.format ?? (opts.out?.endsWith(".csv") ? "csv" : "json");
        let rules: Rule[];
        if (opts.from) rules = loadRules(io, opts.from);
        else {
          if (!base) throw new CliError("export: pass --api <url> or --from <file>", 2);
          const res = await callApi(io, base, "/api/export?format=json");
          if (res.status !== 200) throw new CliError(`export failed with HTTP ${res.status}`);
          rules = (res.body as RuleSetDocument).rules ?? [];
        }
        const data = format === "csv" ? toCsv(rules) : JSON.stringify({ rules }, null, 2) + "\n";
        if (opts.out) {
          io.writeFile(opts.out, data);
          io.out(`wrote ${rules.length} rule(s) to ${opts.out}`);
        } else io.out(data.trimEnd());
        return 0;
      }

      case "test": {
        let rules: Rule[] | null = null;
        let urls = rest;
        if (!base || (rest[0] && !/^https?:\/\//.test(rest[0]))) {
          const file = rest[0];
          if (!file) throw new CliError("test: missing <file>", 2);
          rules = loadRules(io, file);
          urls = rest.slice(1);
        }
        let cases: TestCase[] = urls.map((u) => ({ url: u }));
        if (opts.cases) cases = JSON.parse(io.readFile(opts.cases)) as TestCase[];
        if (cases.length === 0) throw new CliError("test: give at least one URL or --cases", 2);

        const router = rules ? new Router(rules, { allowRegex: opts["allow-regex"] }) : null;
        if (router?.problems.length) {
          for (const p of router.problems) io.err(`skipped rule ${p.ruleId}: ${p.message}`);
        }
        let failures = 0;
        const results: unknown[] = [];
        for (const c of cases) {
          let location: string | null = null;
          let status: number | null = null;
          let ruleId: string | null = null;
          if (router) {
            const m = router.match(c.url, io.now());
            if (m) ({ location, status, ruleId } = { location: m.location, status: m.status, ruleId: m.rule.id });
          } else if (base) {
            const res = await callApi(io, base, `/api/test?url=${encodeURIComponent(c.url)}`);
            const b = res.body as { matched?: boolean; location?: string; status?: number; ruleId?: string };
            if (b.matched) ({ location, status, ruleId } = { location: b.location!, status: b.status!, ruleId: b.ruleId! });
          }
          let pass = true;
          if (c.location !== undefined && c.location !== location) pass = false;
          if (c.status !== undefined && c.status !== status) pass = false;
          if (!pass) failures++;
          results.push({ url: c.url, location, status, ruleId, pass });
          if (!opts.json) {
            const mark = opts.cases ? (pass ? "PASS " : "FAIL ") : "";
            const got = location ? `${status} ${location}  [${ruleId}]` : "no match";
            const want = !pass ? `  (expected ${c.status ?? "-"} ${c.location ?? "no match"})` : "";
            io.out(`${mark}${c.url} -> ${got}${want}`);
          }
        }
        if (opts.json) io.out(JSON.stringify(results, null, 2));
        else if (opts.cases) io.out(`${cases.length - failures}/${cases.length} passed`);
        return failures ? 1 : 0;
      }

      case "diff": {
        const file = rest[0];
        if (!file) throw new CliError("diff: missing <file>", 2);
        const local = loadRules(io, file);
        let remote: Rule[];
        if (opts.against) remote = loadRules(io, opts.against);
        else {
          if (!base) throw new CliError("diff: pass --api <url> or --against <file>", 2);
          const res = await callApi(io, base, "/api/export?format=json");
          if (res.status !== 200) throw new CliError(`diff: export failed with HTTP ${res.status}`);
          remote = (res.body as RuleSetDocument).rules ?? [];
        }
        // "before" = deployed/other, "after" = local file.
        const d = diffRules(remote, local);
        io.out(opts.json ? JSON.stringify(d, null, 2) : summarizeDiff(d));
        return d.added.length || d.removed.length || d.changed.length ? 1 : 0;
      }

      default:
        throw new CliError(`unknown command "${command}"\n${HELP}`, 2);
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(e.message);
      return e.code;
    }
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}

