import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Rule } from "../src/types.js";
import { formatReport, samplePathFor, validateRules, type ValidationReport } from "../src/validate.js";
import { rule } from "./helpers.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const codes = (r: ValidationReport) => r.issues.map((i) => i.code).sort();
const v = (rules: Rule[], opts = {}) => validateRules(rules, { now: NOW, ...opts });

describe("validateRules: structure", () => {
  it("accepts a clean rule set", () => {
    const r = v([rule({ source: "/a", destination: "/b" }), rule({ source: "/blog/*", destination: "https://x.test/$1" })]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.issues, []);
  });

  it("rejects invalid status codes", () => {
    const r = v([
      rule({ source: "/a", destination: "/b", status: 200 }),
      rule({ source: "/c", destination: "/d", status: "abc" }),
      rule({ source: "/e", destination: "/f", status: 303 }),
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.issues.filter((i) => i.code === "invalid_status").length, 3);
  });

  it("rejects unknown types and query modes", () => {
    const r = v([rule({ source: "/a", destination: "/b", type: "glob", query: "keep" })]);
    assert.deepEqual(codes(r), ["invalid_query_mode", "invalid_type"]);
  });

  it("rejects unsafe or malformed destinations", () => {
    const r = v([
      rule({ source: "/a", destination: "javascript:alert(1)" }),
      rule({ source: "/b", destination: "//evil.test/x" }),
      rule({ source: "/c", destination: "ftp://files.test/" }),
      rule({ source: "/d", destination: "relative/path" }),
    ]);
    assert.equal(r.issues.filter((i) => i.code === "invalid_destination").length, 4);
  });

  it("rejects bad sources", () => {
    const r = v([rule({ source: "no-slash", destination: "/b", type: "exact" }), rule({ source: "/:a/:a/*", destination: "/x" })]);
    assert.equal(r.issues.filter((i) => i.code === "invalid_source").length, 2);
  });

  it("flags duplicate ids", () => {
    const r = v([rule({ id: "x", source: "/a", destination: "/b" }), rule({ id: "x", source: "/c", destination: "/d" })]);
    assert.deepEqual(codes(r), ["duplicate_id"]);
  });

  it("checks placeholders against captures", () => {
    const r = v([
      rule({ source: "/a/*", destination: "/b/$2" }),
      rule({ source: "/c/:slug", destination: "/d/$<nope>" }),
      rule({ source: "/e", destination: "/f/$1" }),
    ]);
    assert.deepEqual(codes(r), ["placeholder_in_exact", "unknown_placeholder", "unknown_placeholder"]);
  });

  it("validates dates and windows", () => {
    const r = v([
      rule({ source: "/a", destination: "/b", status: 302, expiresAt: "not-a-date" }),
      rule({ source: "/c", destination: "/d", status: 302, startsAt: "2026-08-01", expiresAt: "2026-07-01" }),
      rule({ source: "/e", destination: "/f", status: 302, expiresAt: "2026-01-01T00:00:00Z" }),
    ]);
    assert.deepEqual(codes(r), ["expired", "invalid_date", "invalid_window"]);
  });

  it("warns about permanent redirects that expire", () => {
    const r = v([rule({ source: "/a", destination: "/b", expiresAt: "2027-01-01T00:00:00Z" })]);
    assert.deepEqual(codes(r), ["permanent_with_expiry"]);
    assert.equal(r.ok, true);
  });

  it("enforces the rule limit", () => {
    const r = v(
      [rule({ source: "/a", destination: "/b" }), rule({ source: "/c", destination: "/d" })],
      { maxRules: 1 },
    );
    assert.ok(codes(r).includes("too_many_rules"));
  });

  it("checks hosts", () => {
    const r = v([rule({ source: "/a", destination: "/b", host: "bad host!" })]);
    assert.deepEqual(codes(r), ["invalid_host"]);
  });
});

describe("validateRules: regex", () => {
  it("errors when regex rules are not enabled", () => {
    const r = v([rule({ type: "regex", source: "^/p/(\\d+)$", destination: "/x/$1" })]);
    assert.deepEqual(codes(r), ["regex_disabled"]);
  });
  it("accepts safe regex when enabled", () => {
    const r = v([rule({ type: "regex", source: "^/p/(\\d+)$", destination: "/x/$1" })], { allowRegex: true });
    assert.equal(r.ok, true);
  });
  it("rejects catastrophic patterns", () => {
    const r = v([rule({ type: "regex", source: "^(a+)+$", destination: "/x" })], { allowRegex: true });
    assert.deepEqual(codes(r), ["unsafe_regex"]);
  });
  it("flags $n beyond the group count", () => {
    const r = v([rule({ type: "regex", source: "^/p/(\\d+)$", destination: "/x/$2" })], { allowRegex: true });
    assert.deepEqual(codes(r), ["unknown_placeholder"]);
  });
});

describe("validateRules: conflicts", () => {
  it("errors on the same source with different destinations", () => {
    const r = v([rule({ source: "/a", destination: "/b" }), rule({ id: "two", source: "/A/", destination: "/c" })]);
    assert.deepEqual(codes(r), ["conflicting_rule"]);
    assert.equal(r.issues[0].ruleId, "two");
  });
  it("warns on exact duplicates", () => {
    const r = v([rule({ source: "/a", destination: "/b" }), rule({ id: "dup", source: "/a", destination: "/b" })]);
    assert.deepEqual(codes(r), ["duplicate_rule"]);
  });
  it("does not conflict across hosts or types", () => {
    const r = v([
      rule({ source: "/a", destination: "/b", host: "one.test" }),
      rule({ source: "/a", destination: "/c", host: "two.test" }),
      rule({ source: "/a", destination: "/d", type: "prefix" }),
    ]);
    assert.ok(!codes(r).includes("conflicting_rule"));
  });
  it("ignores disabled rules for conflicts", () => {
    const r = v([rule({ source: "/a", destination: "/b" }), rule({ id: "off", source: "/a", destination: "/c", enabled: false })]);
    assert.equal(r.ok, true);
  });
});

describe("validateRules: loops and chains", () => {
  it("detects a self redirect", () => {
    const r = v([rule({ source: "/a", destination: "/a/" })]);
    assert.deepEqual(codes(r), ["redirect_loop"]);
  });

  it("detects a two-rule loop", () => {
    const r = v([rule({ id: "ab", source: "/a", destination: "/b" }), rule({ id: "ba", source: "/b", destination: "/a" })]);
    const loops = r.issues.filter((i) => i.code === "redirect_loop");
    assert.equal(loops.length, 2);
    assert.deepEqual(loops[0].path, ["/a", "/b", "/a"]);
  });

  it("detects loops through absolute internal URLs", () => {
    const rules = [
      rule({ source: "/a", destination: "https://www.site.test/b" }),
      rule({ source: "/b", destination: "/a" }),
    ];
    assert.equal(v(rules).ok, true, "external host is not followed");
    assert.equal(v(rules, { internalHosts: ["www.site.test"] }).ok, false);
  });

  it("detects loops through prefix rules", () => {
    const r = v([
      rule({ id: "p1", source: "/old/*", destination: "/new/$1" }),
      rule({ id: "p2", source: "/new/*", destination: "/old/$1" }),
    ]);
    assert.ok(codes(r).includes("redirect_loop"));
  });

  it("errors on an ever-growing prefix rewrite", () => {
    const r = v([rule({ source: "/a/*", destination: "/a/b/$1" })]);
    assert.deepEqual(codes(r), ["chain_too_long"]);
  });

  it("warns on chains with the final hop", () => {
    const r = v([
      rule({ id: "1", source: "/one", destination: "/two" }),
      rule({ id: "2", source: "/two", destination: "/three" }),
      rule({ id: "3", source: "/three", destination: "https://elsewhere.test/" }),
    ]);
    assert.equal(r.ok, true);
    const chain = r.issues.find((i) => i.ruleId === "1");
    assert.equal(chain?.code, "redirect_chain");
    assert.deepEqual(chain?.path, ["/one", "/two", "/three", "https://elsewhere.test/"]);
    assert.match(chain?.message ?? "", /point the rule straight at https:\/\/elsewhere\.test\//);
    assert.equal(r.issues.filter((i) => i.code === "redirect_chain").length, 2);
  });

  it("does not treat a host-scoped rule as part of another host's chain", () => {
    const r = v([
      rule({ source: "/a", destination: "/b", host: "one.test" }),
      rule({ source: "/b", destination: "/a", host: "two.test" }),
    ]);
    assert.equal(r.ok, true);
  });

  it("produces sample paths", () => {
    assert.equal(samplePathFor(rule({ source: "/d/:v/*", destination: "/x" })), "/d/sample-v/sample");
    assert.equal(samplePathFor(rule({ type: "regex", source: "^/x$", destination: "/x" })), null);
  });

  it("formats a readable report", () => {
    const text = formatReport(v([rule({ source: "/a", destination: "/a" })]));
    assert.match(text, /ERROR redirect_loop/);
    assert.match(text, /1 error\(s\), 0 warning\(s\)/);
  });
});
