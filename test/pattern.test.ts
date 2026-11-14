import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capturesFromMatch,
  compilePrefixPattern,
  PatternError,
  referencedPlaceholders,
  substitute,
} from "../src/pattern.js";
import { checkRegexSafety, compileSafeRegex } from "../src/saferegex.js";

function m(pattern: string, path: string, cs = false) {
  const c = compilePrefixPattern(pattern, cs);
  const r = c.regex.exec(path);
  return r ? capturesFromMatch(r, c.names) : null;
}

describe("compilePrefixPattern", () => {
  it("matches a trailing wildcard and the bare prefix", () => {
    assert.deepEqual(m("/blog/*", "/blog/2024/hello")?.positional, ["2024/hello"]);
    assert.deepEqual(m("/blog/*", "/blog")?.positional, [""]);
    assert.deepEqual(m("/blog/*", "/blog/")?.positional, [""]);
    assert.equal(m("/blog/*", "/blogger"), null);
  });

  it("treats a pattern without tokens as a sub-tree", () => {
    assert.ok(m("/shop", "/shop"));
    assert.ok(m("/shop", "/shop/"));
    assert.equal(m("/shop", "/shop/a/b")?.named.splat, "a/b");
    assert.equal(m("/shop", "/shopping"), null);
  });

  it("captures named single-segment parameters", () => {
    const c = m("/docs/:section/:page", "/docs/api/auth");
    assert.deepEqual(c?.named, { section: "api", page: "auth", splat: "" });
    assert.equal(m("/docs/:section/:page", "/docs/api"), null);
  });

  it("supports a wildcard in the middle", () => {
    const c = m("/files/*/download", "/files/a/b/download");
    assert.deepEqual(c?.positional, ["a/b"]);
  });

  it("escapes regex metacharacters in literals", () => {
    assert.ok(m("/a.b/*", "/a.b/x"));
    assert.equal(m("/a.b/*", "/aXb/x"), null);
    assert.ok(m("/c++(x)/*", "/c++(x)/y"));
  });

  it("is case-insensitive unless asked", () => {
    assert.ok(m("/Blog/*", "/BLOG/x"));
    assert.equal(m("/Blog/*", "/blog/x", true), null);
  });

  it("reports literal prefix and counts", () => {
    const c = compilePrefixPattern("/Docs/:s/*");
    assert.equal(c.literalPrefix, "/docs/");
    assert.equal(c.wildcardCount, 1);
    assert.equal(c.paramCount, 1);
  });

  it("rejects bad patterns", () => {
    assert.throws(() => compilePrefixPattern("blog/*"), PatternError);
    assert.throws(() => compilePrefixPattern("/:a/:a"), /duplicate/);
    assert.throws(() => compilePrefixPattern("/:splat"), /reserved/);
    assert.throws(() => compilePrefixPattern("/x/:1"), /invalid parameter/);
  });
});

describe("substitute", () => {
  const caps = { positional: ["one", "two"], named: { slug: "hello", splat: "a/b" } };
  it("replaces positional, named and angle placeholders", () => {
    assert.equal(substitute("/n/$1/$2", caps), "/n/one/two");
    assert.equal(substitute("/p/:slug", caps), "/p/hello");
    assert.equal(substitute("/p/$<slug>/:splat", caps), "/p/hello/a/b");
  });
  it("leaves ports, schemes and unknown names alone", () => {
    assert.equal(substitute("https://x.com:8080/:nope", caps), "https://x.com:8080/:nope");
  });
  it("handles out of range and escaped dollars", () => {
    assert.equal(substitute("/a/$9", caps), "/a/");
    assert.equal(substitute("/price/$$5", caps), "/price/$5");
  });
  it("lists referenced placeholders", () => {
    assert.deepEqual(referencedPlaceholders("/a/$1/$<x>/$$/$12"), { positional: [1, 12], named: ["x"] });
  });
});

describe("checkRegexSafety", () => {
  const unsafe = ["(a+)+$", "(a*)*", "^(\\w+\\s?)*$", "(a|aa)+", "((ab)+)+", "(x+){2,}", "(.*a){1000}x", "(a)\\1", "(?<n>a)\\k<n>"];
  for (const src of unsafe) {
    it(`rejects ${src}`, () => {
      assert.equal(checkRegexSafety(src).ok, false, src);
    });
  }
  const safe = ["^/p/(\\d+)$", "^/(?<lang>en|de)/(.*)$", "^/a[+*]b$", "^/x(?:y)?$", "^/(foo|bar)/baz$", "^/v\\d{1,3}/(.+)$"];
  for (const src of safe) {
    it(`accepts ${src}`, () => {
      assert.equal(checkRegexSafety(src).ok, true, `${src}: ${checkRegexSafety(src).reason}`);
    });
  }
  it("rejects long, empty and invalid patterns", () => {
    assert.equal(checkRegexSafety("a".repeat(300)).ok, false);
    assert.equal(checkRegexSafety("").ok, false);
    assert.match(checkRegexSafety("(").reason ?? "", /invalid/);
  });
  it("compileSafeRegex throws on unsafe input and honours case", () => {
    assert.throws(() => compileSafeRegex("(a+)+"));
    assert.ok(compileSafeRegex("^/A$").test("/a"));
    assert.equal(compileSafeRegex("^/A$", true).test("/a"), false);
  });
});
