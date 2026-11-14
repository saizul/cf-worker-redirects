import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { authorize, constantTimeEqual, constantTimeEqualBytes, extractBearer } from "../src/auth.js";
import { configFromEnv } from "../src/config.js";
import { KvCounter } from "../src/counters.js";
import { RULESET_KEY, toDocument } from "../src/io.js";
import { RedirectService } from "../src/service.js";
import { D1RuleStore, KvRuleStore, storeFromEnv } from "../src/storage.js";
import type { Env, Rule } from "../src/types.js";
import worker from "../src/index.js";
import { MemoryAnalytics, MemoryD1, MemoryKV, rule, TOKEN, WaitUntil } from "./helpers.js";

const BASE = "https://go.example.com";

function seed(kv: MemoryKV, rules: Rule[]) {
  kv.data.set(RULESET_KEY, { value: JSON.stringify(toDocument(rules)) });
}

function admin(path: string, init: RequestInit & { token?: string | null } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? TOKEN}`);
  return new Request(`${BASE}/__redirects${path}`, { ...init, headers });
}

describe("auth", () => {
  it("compares in constant time over digests", async () => {
    assert.equal(await constantTimeEqual("abc", "abc"), true);
    assert.equal(await constantTimeEqual("abc", "abd"), false);
    assert.equal(await constantTimeEqual("abc", "abcd"), false);
    assert.equal(constantTimeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1])), false);
  });
  it("extracts bearer tokens strictly", () => {
    assert.equal(extractBearer("Bearer abc"), "abc");
    assert.equal(extractBearer("bearer   abc  "), "abc");
    assert.equal(extractBearer("Basic abc"), null);
    assert.equal(extractBearer("Bearer a b"), null);
    assert.equal(extractBearer(null), null);
  });
  it("fails closed without a strong token", async () => {
    assert.deepEqual(await authorize("Bearer x", undefined), {
      ok: false,
      status: 503,
      reason: "admin API disabled: ADMIN_TOKEN must be set (>= 32 chars)",
    });
    assert.equal((await authorize("Bearer short", "short")).ok, false);
    assert.equal((await authorize(`Bearer ${TOKEN}`, TOKEN)).ok, true);
    assert.equal((await authorize(`Bearer ${TOKEN}x`, TOKEN)).ok, false);
    assert.equal((await authorize(null, TOKEN)).ok, false);
  });
});

describe("config", () => {
  it("has safe defaults", () => {
    const c = configFromEnv({});
    assert.equal(c.adminPath, "/__redirects");
    assert.equal(c.allowRegex, false);
    assert.equal(c.fallback, "404");
    assert.equal(c.cacheTtl, 60);
  });
  it("parses and clamps values", () => {
    const c = configFromEnv({
      ADMIN_PATH: "admin/",
      ENABLE_REGEX: "TRUE",
      REGEX_BUDGET_MS: "999",
      FALLBACK: "passthrough",
      CACHE_TTL: "abc",
      INTERNAL_HOSTS: "A.test, b.test,,",
    });
    assert.equal(c.adminPath, "/admin");
    assert.equal(c.allowRegex, true);
    assert.equal(c.regexBudgetMs, 50);
    assert.equal(c.fallback, "passthrough");
    assert.equal(c.cacheTtl, 60);
    assert.deepEqual(c.internalHosts, ["a.test", "b.test"]);
  });
});

describe("storage", () => {
  it("KV store round-trips and sets metadata", async () => {
    const kv = new MemoryKV();
    const store = new KvRuleStore(kv);
    assert.equal(await store.load(), null);
    await store.save([rule({ source: "/a", destination: "/b" })]);
    assert.equal((await store.load())?.rules.length, 1);
    assert.deepEqual((kv.data.get(RULESET_KEY)?.metadata as { count: number }).count, 1);
  });
  it("D1 store round-trips", async () => {
    const db = new MemoryD1();
    const store = new D1RuleStore(db);
    assert.equal(await store.load(), null);
    await store.save([rule({ source: "/a", destination: "/b" })]);
    assert.equal((await store.load())?.rules[0].source, "/a");
  });
  it("rejects unknown stored formats", async () => {
    const kv = new MemoryKV();
    kv.data.set(RULESET_KEY, { value: '{"version":9}' });
    await assert.rejects(new KvRuleStore(kv).load(), /unknown format/);
  });
  it("selects a backend from env", () => {
    assert.equal(storeFromEnv({ REDIRECTS: new MemoryKV() }).kind, "kv");
    assert.equal(storeFromEnv({ DB: new MemoryD1() }).kind, "d1");
    assert.throws(() => storeFromEnv({ STORAGE: "d1" }), /no DB binding/);
    assert.throws(() => storeFromEnv({}), /no REDIRECTS/);
  });
});

describe("worker: redirects", () => {
  let kv: MemoryKV;
  let env: Env;
  let service: RedirectService;

  beforeEach(() => {
    kv = new MemoryKV();
    env = { REDIRECTS: kv, ADMIN_TOKEN: TOKEN };
    service = new RedirectService();
    seed(kv, [
      rule({ id: "home", source: "/old", destination: "/new" }),
      rule({ id: "temp", source: "/promo", destination: "https://shop.test/sale", status: 307, utm_source: "go" }),
    ]);
  });

  it("redirects with Location and cache headers", async () => {
    const res = await service.fetch(new Request(`${BASE}/old?a=1`), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/new?a=1");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  });

  it("temporary redirects are not cached", async () => {
    const res = await service.fetch(new Request(`${BASE}/promo`), env);
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), "https://shop.test/sale?utm_source=go");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("returns 404 by default when nothing matches", async () => {
    const res = await service.fetch(new Request(`${BASE}/nope`), env);
    assert.equal(res.status, 404);
  });

  it("can fall back to a fixed URL", async () => {
    const res = await service.fetch(new Request(`${BASE}/nope`), { ...env, FALLBACK: "redirect", FALLBACK_URL: "https://example.com/" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://example.com/");
  });

  it("caches the compiled rule set inside the isolate", async () => {
    await service.fetch(new Request(`${BASE}/old`), env);
    await service.fetch(new Request(`${BASE}/old`), env);
    await service.fetch(new Request(`${BASE}/promo`), env);
    assert.equal(kv.gets, 1);
  });

  it("reloads after the cache TTL", async () => {
    let t = 1_000_000;
    const s = new RedirectService({ now: () => t });
    await s.fetch(new Request(`${BASE}/old`), env);
    t += 61_000;
    await s.fetch(new Request(`${BASE}/old`), env);
    assert.equal(kv.gets, 2);
  });

  it("reports misconfiguration", async () => {
    const res = await service.fetch(new Request(`${BASE}/old`), {});
    assert.equal(res.status, 500);
  });

  it("counts clicks in KV via waitUntil", async () => {
    const ctx = new WaitUntil();
    await service.fetch(new Request(`${BASE}/old`), { ...env, COUNTER: "kv" }, ctx);
    await service.fetch(new Request(`${BASE}/old`), { ...env, COUNTER: "kv" }, ctx);
    await ctx.flush();
    assert.deepEqual(await new KvCounter(kv).read(), { home: 2 });
    assert.deepEqual(await new KvCounter(kv).read(["home", "temp"]), { home: 2, temp: 0 });
  });

  it("writes Analytics Engine data points", async () => {
    const ae = new MemoryAnalytics();
    const req = new Request(`${BASE}/old`, { headers: { referer: "https://ref.test/page" } });
    await service.fetch(req, { ...env, COUNTER: "analytics", CLICKS: ae });
    assert.equal(ae.points.length, 1);
    assert.deepEqual(ae.points[0].indexes, ["home"]);
    assert.deepEqual(ae.points[0].blobs, ["home", "go.example.com", "/old", "/new", "301", "", "ref.test"]);
    assert.deepEqual(ae.points[0].doubles, [1]);
  });

  it("the default export delegates to the service", async () => {
    const res = await worker.fetch(new Request(`${BASE}/old`), env, new WaitUntil());
    assert.equal(res.status, 301);
  });
});

describe("worker: admin API", () => {
  let kv: MemoryKV;
  let env: Env;
  let service: RedirectService;
  const call = (req: Request) => service.fetch(req, env);

  beforeEach(() => {
    kv = new MemoryKV();
    env = { REDIRECTS: kv, ADMIN_TOKEN: TOKEN, COUNTER: "kv" };
    service = new RedirectService();
  });

  it("health needs no token", async () => {
    const res = await call(admin("/health", { token: null }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, storage: "kv", rules: 0, updatedAt: null });
  });

  it("rejects missing and wrong tokens", async () => {
    assert.equal((await call(admin("/api/rules", { token: null }))).status, 401);
    const res = await call(admin("/api/rules", { token: "x".repeat(40) }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
  });

  it("is disabled without ADMIN_TOKEN", async () => {
    env.ADMIN_TOKEN = undefined;
    assert.equal((await call(admin("/api/rules"))).status, 503);
  });

  it("replaces, reads, upserts and deletes rules", async () => {
    let res = await call(
      admin("/api/rules", { method: "PUT", body: JSON.stringify({ rules: [{ id: "a", source: "/a", destination: "/b" }] }) }),
    );
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { saved: boolean }).saved, true);

    // New rule is live in this isolate immediately.
    assert.equal((await call(new Request(`${BASE}/a`))).headers.get("location"), "/b");

    res = await call(admin("/api/rules", { method: "POST", body: JSON.stringify({ id: "c", source: "/c", destination: "/d" }) }));
    assert.equal(res.status, 200);
    res = await call(admin("/api/rules"));
    assert.deepEqual(((await res.json()) as { rules: Rule[] }).rules.map((r) => r.id), ["a", "c"]);

    res = await call(admin("/api/rules/c"));
    assert.equal(((await res.json()) as Rule).destination, "/d");

    res = await call(admin("/api/rules/c", { method: "DELETE" }));
    assert.equal(res.status, 200);
    assert.equal((await call(admin("/api/rules/c"))).status, 404);
    assert.equal((await call(admin("/api/rules/zzz", { method: "DELETE" }))).status, 404);
  });

  it("refuses rule sets with validation errors", async () => {
    const res = await call(
      admin("/api/rules", {
        method: "PUT",
        body: JSON.stringify([
          { source: "/a", destination: "/b" },
          { source: "/b", destination: "/a" },
        ]),
      }),
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as { report: { issues: { code: string }[] } };
    assert.ok(body.report.issues.some((i) => i.code === "redirect_loop"));
    assert.equal(kv.puts, 0);
  });

  it("detects loops via the Worker's own hostname", async () => {
    const res = await call(
      admin("/api/rules", {
        method: "PUT",
        body: JSON.stringify([{ source: "/a", destination: `${BASE}/a` }]),
      }),
    );
    assert.equal(res.status, 422);
  });

  it("rejects malformed bodies", async () => {
    assert.equal((await call(admin("/api/rules", { method: "PUT", body: "not json" }))).status, 400);
    assert.equal((await call(admin("/api/rules", { method: "PUT", body: '[{"source":"/a"}]' }))).status, 400);
    assert.equal((await call(admin("/api/rules", { method: "PATCH", body: "[]" }))).status, 405);
    assert.equal((await call(admin("/api/nope"))).status, 404);
  });

  it("rejects oversized bodies by content-length", async () => {
    const res = await call(
      admin("/api/rules", { method: "PUT", body: "[]", headers: { "content-length": String(30 * 1024 * 1024) } }),
    );
    assert.equal(res.status, 413);
  });

  it("imports CSV with dry-run and merge modes", async () => {
    const csv = "source,destination,status\n/x,/y,302\n";
    let res = await call(admin("/api/import?format=csv&dryRun=1", { method: "POST", body: csv }));
    assert.equal(((await res.json()) as { dryRun: boolean }).dryRun, true);
    assert.equal(kv.puts, 0);

    res = await call(admin("/api/import?format=csv", { method: "POST", body: csv }));
    assert.equal(res.status, 200);
    res = await call(admin("/api/import?format=csv&mode=merge", { method: "POST", body: "source,destination\n/z,/w\n" }));
    assert.equal(((await res.json()) as { count: number }).count, 2);

    res = await call(admin("/api/import?format=csv", { method: "POST", body: "source,destination\n/z,\n" }));
    assert.equal(res.status, 400);
    res = await call(admin("/api/import?format=json", { method: "POST", body: "{" }));
    assert.equal(res.status, 400);
  });

  it("exports JSON and CSV", async () => {
    await call(admin("/api/rules", { method: "PUT", body: JSON.stringify([{ id: "a", source: "/a", destination: "/b" }]) }));
    let res = await call(admin("/api/export?format=csv"));
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(await res.text(), /^id,type,source/);
    res = await call(admin("/api/export"));
    assert.equal(((await res.json()) as { rules: Rule[] }).rules.length, 1);
  });

  it("validates without saving", async () => {
    const res = await call(admin("/api/validate", { method: "POST", body: JSON.stringify([{ source: "/a", destination: "/b", status: 200 }]) }));
    const report = (await res.json()) as { ok: boolean };
    assert.equal(report.ok, false);
    assert.equal(kv.puts, 0);
  });

  it("tests a URL against the live rules", async () => {
    await call(admin("/api/rules", { method: "PUT", body: JSON.stringify([{ id: "a", source: "/a/*", destination: "/b/$1" }]) }));
    let res = await call(admin(`/api/test?url=${encodeURIComponent("/a/x?q=1")}`));
    let body = (await res.json()) as { matched: boolean; location: string; ruleId: string };
    assert.equal(body.matched, true);
    assert.equal(body.location, "/b/x?q=1");
    assert.equal(body.ruleId, "a");
    res = await call(admin("/api/test", { method: "POST", body: JSON.stringify({ url: "https://other.test/zzz" }) }));
    body = (await res.json()) as { matched: boolean; location: string; ruleId: string };
    assert.equal(body.matched, false);
    assert.equal((await call(admin("/api/test"))).status, 400);
  });

  it("reports click stats", async () => {
    await call(admin("/api/rules", { method: "PUT", body: JSON.stringify([{ id: "a", source: "/a", destination: "/b" }]) }));
    await call(new Request(`${BASE}/a`));
    const res = await call(admin("/api/stats"));
    assert.deepEqual(await res.json(), { counter: "kv", clicks: { a: 1 } });
    env.COUNTER = "none";
    const res2 = await call(admin("/api/stats"));
    assert.equal(((await res2.json()) as { counter: string }).counter, "none");
  });

  it("works with D1 storage", async () => {
    const db = new MemoryD1();
    env = { DB: db, ADMIN_TOKEN: TOKEN, STORAGE: "d1" };
    await call(admin("/api/rules", { method: "PUT", body: JSON.stringify([{ id: "a", source: "/a", destination: "/b" }]) }));
    assert.ok(db.row);
    const fresh = new RedirectService();
    const res = await fresh.fetch(new Request(`${BASE}/a`), env);
    assert.equal(res.headers.get("location"), "/b");
  });

  it("honours a custom admin path", async () => {
    env.ADMIN_PATH = "/ops";
    const res = await call(new Request(`${BASE}/ops/health`));
    assert.equal(res.status, 200);
  });
});
