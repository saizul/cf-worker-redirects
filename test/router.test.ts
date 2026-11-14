import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLocation } from "../src/location.js";
import { newTrace, Router } from "../src/router.js";
import { rule } from "./helpers.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const go = (r: Router, url: string, now = NOW) => r.match(url, now);

describe("Router: exact rules", () => {
  const router = new Router([
    rule({ source: "/old", destination: "/new" }),
    rule({ source: "/About-Us/", destination: "https://example.org/about", status: 308 }),
    rule({ source: "/promo", destination: "/sale", status: 302, query: "strip" }),
    rule({ source: "/case", destination: "/sensitive", caseSensitive: true }),
    rule({ source: "/item?id=5", destination: "/products/five" }),
    rule({ source: "/item", destination: "/products" }),
    rule({ source: "/caf%C3%A9", destination: "/coffee" }),
  ]);

  it("matches and defaults to 301", () => {
    const m = go(router, "https://a.test/old");
    assert.equal(m?.status, 301);
    assert.equal(m?.location, "/new");
  });

  it("ignores trailing slash and case by default", () => {
    assert.equal(go(router, "https://a.test/old/")?.location, "/new");
    assert.equal(go(router, "https://a.test/OLD")?.location, "/new");
    assert.equal(go(router, "https://a.test/about-us")?.location, "https://example.org/about");
    assert.equal(go(router, "https://a.test/about-us")?.status, 308);
  });

  it("honours caseSensitive", () => {
    assert.equal(go(router, "https://a.test/case")?.location, "/sensitive");
    assert.equal(go(router, "https://a.test/CASE"), null);
  });

  it("preserves the incoming query string by default", () => {
    assert.equal(go(router, "https://a.test/old?x=1&y=2")?.location, "/new?x=1&y=2");
  });

  it("strips the query string when asked", () => {
    assert.equal(go(router, "https://a.test/promo?ref=abc")?.location, "/sale");
  });

  it("matches query-qualified exact sources first and consumes those keys", () => {
    assert.equal(go(router, "https://a.test/item?id=5&lang=en")?.location, "/products/five?lang=en");
    assert.equal(go(router, "https://a.test/item?id=6")?.location, "/products?id=6");
  });

  it("matches percent-encoded and decoded paths alike", () => {
    assert.equal(go(router, "https://a.test/café")?.location, "/coffee");
  });

  it("returns null when nothing matches", () => {
    assert.equal(go(router, "https://a.test/nothing"), null);
  });
});

describe("Router: prefix rules", () => {
  const router = new Router([
    rule({ source: "/blog/*", destination: "https://news.example.com/$1" }),
    rule({ source: "/blog/archive/*", destination: "/archive/:splat", status: 302 }),
    rule({ source: "/docs/:version/*", destination: "/documentation/:version/$2" }),
    rule({ type: "prefix", source: "/shop", destination: "https://shop.example.com" }),
    rule({ source: "/exact-wins", destination: "/exact" }),
    rule({ source: "/exact-wins/*", destination: "/prefix" }),
  ]);

  it("substitutes the wildcard capture", () => {
    assert.equal(go(router, "https://a.test/blog/2024/post")?.location, "https://news.example.com/2024/post");
  });

  it("prefers the longer literal prefix regardless of order", () => {
    const m = go(router, "https://a.test/blog/archive/x");
    assert.equal(m?.location, "/archive/x");
    assert.equal(m?.status, 302);
  });

  it("combines named parameters and positional wildcards", () => {
    assert.equal(go(router, "https://a.test/docs/v2/guide/intro")?.location, "/documentation/v2/guide/intro");
  });

  it("redirects a bare sub-tree", () => {
    assert.equal(go(router, "https://a.test/shop/cart?x=1")?.location, "https://shop.example.com/?x=1");
  });

  it("checks exact rules before prefixes", () => {
    assert.equal(go(router, "https://a.test/exact-wins")?.location, "/exact");
    assert.equal(go(router, "https://a.test/exact-wins/x")?.location, "/prefix");
  });

  it("refuses captures that would produce a protocol-relative URL", () => {
    const r = new Router([rule({ source: "/go/*", destination: "/$1" })]);
    const trace = newTrace();
    assert.equal(r.match("https://a.test/go//evil.example", NOW, trace), null);
    assert.deepEqual(trace.unsafe.length, 1);
    assert.equal(r.match("https://a.test/go/fine", NOW)?.location, "/fine");
  });
});

describe("Router: hosts, time windows and enabled flag", () => {
  const router = new Router([
    rule({ source: "/x", destination: "/a-only", host: "a.test" }),
    rule({ source: "/x", destination: "/wild", host: "*.b.test" }),
    rule({ source: "/x", destination: "/any" }),
    rule({ source: "/sale", destination: "/summer", status: 302, expiresAt: "2026-07-01T00:00:00Z" }),
    rule({ source: "/soon", destination: "/launch", startsAt: "2026-06-15T00:00:00Z" }),
    rule({ source: "/off", destination: "/never", enabled: false }),
  ]);

  it("filters by host", () => {
    assert.equal(go(router, "https://a.test/x")?.location, "/a-only");
    assert.equal(go(router, "https://shop.b.test/x")?.location, "/wild");
    assert.equal(go(router, "https://b.test/x")?.location, "/any");
    assert.equal(go(router, "https://c.test/x")?.location, "/any");
  });

  it("stops matching after expiry", () => {
    assert.equal(go(router, "https://a.test/sale")?.location, "/summer");
    assert.equal(go(router, "https://a.test/sale", Date.parse("2026-07-01T00:00:00Z")), null);
  });

  it("starts matching at startsAt", () => {
    assert.equal(go(router, "https://a.test/soon"), null);
    assert.equal(go(router, "https://a.test/soon", Date.parse("2026-06-16T00:00:00Z"))?.location, "/launch");
  });

  it("skips disabled rules", () => {
    assert.equal(go(router, "https://a.test/off"), null);
  });
});

describe("Router: regex rules", () => {
  const rules = [
    rule({ type: "regex", source: "^/p/(\\d+)$", destination: "/posts/$1" }),
    rule({ type: "regex", source: "^/(?<lang>en|de)/old/(.*)$", destination: "/$<lang>/new/$2" }),
    rule({ type: "regex", source: "(a+)+$", destination: "/boom" }),
  ];

  it("is disabled unless allowRegex is set", () => {
    const r = new Router(rules);
    assert.equal(r.problems.length, 3);
    assert.equal(go(r, "https://a.test/p/1"), null);
  });

  it("matches with positional and named groups", () => {
    const r = new Router(rules, { allowRegex: true });
    assert.equal(r.problems.length, 1, "unsafe regex is rejected at compile time");
    assert.equal(go(r, "https://a.test/p/42")?.location, "/posts/42");
    assert.equal(go(r, "https://a.test/de/old/a/b")?.location, "/de/new/a/b");
    assert.equal(go(r, "https://a.test/p/x"), null);
  });

  it("skips regex evaluation for overlong paths", () => {
    const r = new Router(rules, { allowRegex: true, regexMaxInput: 10 });
    assert.equal(go(r, "https://a.test/p/123456789012"), null);
  });

  it("stops when the time budget is exhausted", () => {
    const many = Array.from({ length: 50 }, (_, i) => rule({ type: "regex", source: `^/never-${i}$`, destination: "/x" }));
    const r = new Router(many, { allowRegex: true, regexBudgetMs: 0 });
    const realNow = Date.now;
    let t = 0;
    Date.now = () => (t += 1);
    try {
      const trace = newTrace();
      assert.equal(r.match("https://a.test/zzz", NOW, trace), null);
      assert.ok(trace.regexSkipped > 0);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("buildLocation", () => {
  const url = new URL("https://a.test/old?utm_source=incoming&x=1#frag");
  it("appends UTM parameters without overriding existing ones", () => {
    const r = rule({
      source: "/old",
      destination: "https://shop.example.com/?utm_medium=keep",
      utm: { source: "newsletter", medium: "email", campaign: "spring" },
    });
    const loc = new URL(buildLocation(r, { positional: [], named: {} }, url));
    assert.equal(loc.searchParams.get("utm_source"), "incoming");
    assert.equal(loc.searchParams.get("utm_medium"), "keep");
    assert.equal(loc.searchParams.get("utm_campaign"), "spring");
    assert.equal(loc.searchParams.get("x"), "1");
  });
  it("applies UTM even when the query is stripped", () => {
    const r = rule({ source: "/old", destination: "/n", query: "strip", utm_source: "qr" });
    assert.equal(buildLocation(r, { positional: [], named: {} }, url), "/n?utm_source=qr");
  });
  it("keeps the destination fragment", () => {
    const r = rule({ source: "/old", destination: "/n#top", query: "strip" });
    assert.equal(buildLocation(r, { positional: [], named: {} }, url), "/n#top");
  });
  it("rejects unsafe substituted destinations", () => {
    const r = rule({ source: "/old", destination: "javascript:alert(1)" });
    assert.throws(() => buildLocation(r, { positional: [], named: {} }, url));
  });
});
