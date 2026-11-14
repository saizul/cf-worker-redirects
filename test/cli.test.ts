import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run, VERSION, type CliIO } from "../src/cli.js";
import { RedirectService } from "../src/service.js";
import type { Env } from "../src/types.js";
import { MemoryKV, TOKEN } from "./helpers.js";

interface Harness {
  io: CliIO;
  out: string[];
  err: string[];
  files: Map<string, string>;
  env: Env;
}

/** CLI harness whose fetch is wired straight into an in-memory Worker. */
function harness(files: Record<string, string> = {}, envOverrides: Record<string, string> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const fileMap = new Map(Object.entries(files));
  const workerEnv: Env = { REDIRECTS: new MemoryKV(), ADMIN_TOKEN: TOKEN };
  const service = new RedirectService();
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { CFWR_ADMIN_TOKEN: TOKEN, ...envOverrides },
    fetch: (async (input: string | URL, init?: RequestInit) =>
      service.fetch(new Request(input as string, init), workerEnv)) as typeof fetch,
    readFile: (p) => {
      const v = fileMap.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFile: (p, d) => fileMap.set(p, d),
    now: () => Date.parse("2026-06-01T00:00:00Z"),
  };
  return { io, out, err, files: fileMap, env: workerEnv };
}

const API = ["--api", "https://go.example.com"];
const GOOD_CSV = "source,destination,status\n/a,/b,301\n/blog/*,https://news.test/$1,302\n";

describe("cli", () => {
  it("prints help and version", async () => {
    const h = harness();
    assert.equal(await run(["--version"], h.io), 0);
    assert.equal(h.out[0], VERSION);
    assert.equal(await run([], h.io), 2);
    assert.equal(await run(["--help"], h.io), 0);
    assert.match(h.out.join("\n"), /Usage:/);
    assert.equal(await run(["frobnicate"], h.io), 2);
    assert.equal(await run(["--bogus"], h.io), 2);
  });

  it("validate returns 0 for good files and 1 for bad ones", async () => {
    const h = harness({ "good.csv": GOOD_CSV, "bad.csv": "source,destination\n/a,/b\n/b,/a\n" });
    assert.equal(await run(["validate", "good.csv"], h.io), 0);
    assert.equal(await run(["validate", "bad.csv"], h.io), 1);
    assert.match(h.out.join("\n"), /redirect_loop/);
    assert.equal(await run(["validate", "missing.csv"], h.io), 1);
    assert.match(h.err.join("\n"), /cannot read/);
  });

  it("validate --json emits a report", async () => {
    const h = harness({ "good.csv": GOOD_CSV });
    await run(["validate", "good.csv", "--json"], h.io);
    assert.equal(JSON.parse(h.out[0]).ok, true);
  });

  it("validate reports rows that cannot be parsed", async () => {
    const h = harness({ "x.csv": "source,destination\n/a,\n" });
    assert.equal(await run(["validate", "x.csv"], h.io), 1);
    assert.match(h.err.join("\n"), /missing destination/);
  });

  it("regex needs --allow-regex", async () => {
    const h = harness({ "r.json": '[{"type":"regex","source":"^/p/(\\\\d+)$","destination":"/posts/$1"}]' });
    assert.equal(await run(["validate", "r.json"], h.io), 1);
    assert.equal(await run(["validate", "r.json", "--allow-regex"], h.io), 0);
  });

  it("import --kv-bulk writes a wrangler bulk file", async () => {
    const h = harness({ "good.csv": GOOD_CSV });
    assert.equal(await run(["import", "good.csv", "--kv-bulk", "bulk.json"], h.io), 0);
    const bulk = JSON.parse(h.files.get("bulk.json")!);
    assert.equal(bulk[0].key, "ruleset:v1");
    assert.equal(JSON.parse(bulk[0].value).rules.length, 2);
    assert.match(h.out.join("\n"), /wrangler kv bulk put bulk\.json/);
  });

  it("import refuses invalid files and warnings without --force", async () => {
    const h = harness({
      "bad.csv": "source,destination,status\n/a,/b,200\n",
      "warn.csv": "source,destination\n/one,/two\n/two,https://x.test/\n",
    });
    assert.equal(await run(["import", "bad.csv", "--kv-bulk", "o.json"], h.io), 1);
    assert.equal(await run(["import", "warn.csv", "--kv-bulk", "o.json"], h.io), 1);
    assert.match(h.err.join("\n"), /--force/);
    assert.equal(await run(["import", "warn.csv", "--kv-bulk", "o.json", "--force"], h.io), 0);
    assert.equal(await run(["import", "warn.csv"], h.io), 2);
  });

  it("import --api uploads, then export and diff read back", async () => {
    const h = harness({ "good.csv": GOOD_CSV, "changed.csv": "source,destination,status\n/a,/c,301\n/new,/x,302\n" });
    assert.equal(await run(["import", "good.csv", ...API, "--dry-run"], h.io), 0);
    assert.match(h.out.at(-1)!, /dry run OK: 2/);
    assert.equal(await run(["import", "good.csv", ...API], h.io), 0);
    assert.match(h.out.at(-1)!, /imported 2/);

    assert.equal(await run(["export", ...API, "--out", "rules.csv"], h.io), 0);
    assert.match(h.files.get("rules.csv")!, /^id,type,source/);

    assert.equal(await run(["diff", "good.csv", ...API], h.io), 0);
    assert.match(h.out.at(-1)!, /0 added, 0 removed, 0 changed, 2 unchanged/);

    assert.equal(await run(["diff", "changed.csv", ...API], h.io), 1);
    const text = h.out.at(-1)!;
    assert.match(text, /\+ .* \/new -> \/x/);
    assert.match(text, /- .* \/blog\/\*/);
    assert.match(text, /~ .*destination/);
  });

  it("api errors surface clearly", async () => {
    const h = harness({ "good.csv": GOOD_CSV }, { CFWR_ADMIN_TOKEN: "wrong-token-wrong-token-wrong-token" });
    assert.equal(await run(["import", "good.csv", ...API], h.io), 1);
    assert.match(h.err.join("\n"), /refused the request \(401\)/);
    const h2 = harness({ "good.csv": GOOD_CSV });
    delete h2.io.env.CFWR_ADMIN_TOKEN;
    assert.equal(await run(["export", ...API], h2.io), 1);
    assert.match(h2.err.join("\n"), /CFWR_ADMIN_TOKEN is not set/);
  });

  it("server-side validation failures are reported", async () => {
    const h = harness({ "loop.csv": "source,destination\n/a,https://go.example.com/a\n" });
    // Locally the host is unknown, so it passes; the Worker knows its own host and refuses.
    assert.equal(await run(["import", "loop.csv", ...API], h.io), 1);
    assert.match(h.err.join("\n"), /HTTP 422/);
  });

  it("export --from converts formats locally", async () => {
    const h = harness({ "good.csv": GOOD_CSV });
    assert.equal(await run(["export", "--from", "good.csv", "--format", "json"], h.io), 0);
    assert.equal(JSON.parse(h.out.at(-1)!).rules.length, 2);
    assert.equal(await run(["export"], h.io), 2);
  });

  it("test matches URLs against a local file", async () => {
    const h = harness({ "good.csv": GOOD_CSV });
    assert.equal(await run(["test", "good.csv", "https://x.test/a?q=1", "https://x.test/zzz"], h.io), 0);
    assert.match(h.out[0], /-> 301 \/b\?q=1/);
    assert.match(h.out[1], /no match/);
    assert.equal(await run(["test", "good.csv"], h.io), 2);
  });

  it("test --cases checks expectations and fails on mismatch", async () => {
    const cases = [
      { url: "https://x.test/a", location: "/b", status: 301 },
      { url: "https://x.test/blog/p", location: "https://news.test/p", status: 302 },
      { url: "https://x.test/none", location: null },
    ];
    const h = harness({ "good.csv": GOOD_CSV, "cases.json": JSON.stringify(cases) });
    assert.equal(await run(["test", "good.csv", "--cases", "cases.json"], h.io), 0);
    assert.match(h.out.at(-1)!, /3\/3 passed/);

    const wrong = [{ url: "https://x.test/a", location: "/elsewhere" }];
    h.files.set("wrong.json", JSON.stringify(wrong));
    assert.equal(await run(["test", "good.csv", "--cases", "wrong.json"], h.io), 1);
    assert.match(h.out.join("\n"), /FAIL https:\/\/x\.test\/a/);
  });

  it("test --api asks the deployed Worker", async () => {
    const h = harness({ "good.csv": GOOD_CSV });
    await run(["import", "good.csv", ...API], h.io);
    assert.equal(await run(["test", ...API, "https://go.example.com/blog/x", "--json"], h.io), 0);
    const results = JSON.parse(h.out.at(-1)!);
    assert.equal(results[0].location, "https://news.test/x");
  });

  it("diff --against compares two files", async () => {
    const h = harness({ "a.csv": GOOD_CSV, "b.csv": GOOD_CSV });
    assert.equal(await run(["diff", "a.csv", "--against", "b.csv", "--json"], h.io), 0);
    assert.equal(JSON.parse(h.out.at(-1)!).unchanged, 2);
    assert.equal(await run(["diff", "a.csv"], h.io), 2);
  });
});
