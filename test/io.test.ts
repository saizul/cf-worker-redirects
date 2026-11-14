import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffRules, parseCsv, parseCsvRows, parseJson, parseRules, RULESET_KEY, toCsv, toKvBulk } from "../src/io.js";
import { inferType, isActive, normalizeRule, ruleIdFor } from "../src/rules.js";
import { rule } from "./helpers.js";

describe("parseCsvRows", () => {
  it("handles quotes, escaped quotes, CRLF, BOM, comments and blank lines", () => {
    const text = '﻿a,b,c\r\n"x, y","he said ""hi""",z\n\n# comment\n"multi\nline",2,3';
    assert.deepEqual(parseCsvRows(text), [
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "z"],
      ["multi\nline", "2", "3"],
    ]);
  });
  it("throws on an unterminated quote", () => {
    assert.throws(() => parseCsvRows('a,"b'), /unterminated/);
  });
});

describe("parseCsv", () => {
  it("reads a full header with aliases and UTM columns", () => {
    const csv = [
      "from,to,code,host,query,expires,enabled,note,utm_source,utm_campaign",
      "/old,/new,302,Example.com,strip,2027-01-01T00:00:00Z,yes,moved,newsletter,spring",
    ].join("\n");
    const { rules, errors } = parseCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(rules.length, 1);
    const r = rules[0];
    assert.equal(r.source, "/old");
    assert.equal(r.destination, "/new");
    assert.equal(r.status, 302);
    assert.equal(r.host, "example.com");
    assert.equal(r.query, "strip");
    assert.equal(r.expiresAt, "2027-01-01T00:00:00Z");
    assert.equal(r.enabled, true);
    assert.equal(r.note, "moved");
    assert.deepEqual(r.utm, { source: "newsletter", campaign: "spring" });
  });

  it("accepts a header-less source,destination,status file", () => {
    const { rules } = parseCsv("/a,/b\n/c,https://x.test/,308\n");
    assert.equal(rules.length, 2);
    assert.equal(rules[0].status, 301);
    assert.equal(rules[1].status, 308);
  });

  it("collects row errors instead of failing the whole file", () => {
    const { rules, errors } = parseCsv("source,destination\n/a,/b\n/c,\n,/d\n");
    assert.equal(rules.length, 1);
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /row 2: missing destination/);
  });
});

describe("parseJson", () => {
  it("accepts an array or {rules}", () => {
    assert.equal(parseJson('[{"source":"/a","destination":"/b"}]').rules.length, 1);
    assert.equal(parseJson('{"rules":[{"from":"/a","to":"/b","utm":{"utm_medium":"qr"}}]}').rules[0].utm?.medium, "qr");
  });
  it("rejects other shapes and bad JSON", () => {
    assert.throws(() => parseJson('{"x":1}'), /expected an array/);
    assert.throws(() => parseJson("{"), /JSON/);
  });
  it("parseRules picks a parser by name or content", () => {
    assert.equal(parseRules("/a,/b", "rules.csv").rules.length, 1);
    assert.equal(parseRules('[{"source":"/a","destination":"/b"}]', "stdin").rules.length, 1);
    assert.equal(parseRules("source,destination\n/a,/b", "stdin").rules.length, 1);
  });
});

describe("normalizeRule", () => {
  it("infers type and defaults", () => {
    assert.equal(inferType("/a"), "exact");
    assert.equal(inferType("/a/*"), "prefix");
    assert.equal(inferType("/a/:id"), "prefix");
    assert.equal(inferType("^/a$"), "regex");
    const r = normalizeRule({ source: "/x/*", destination: "/y/$1" });
    assert.equal(r.type, "prefix");
    assert.equal(r.status, 301);
    assert.equal(r.query, "preserve");
    assert.equal(r.enabled, true);
  });
  it("generates stable ids", () => {
    const a = normalizeRule({ source: "/x", destination: "/1" });
    const b = normalizeRule({ source: "/x", destination: "/2" });
    assert.equal(a.id, b.id);
    assert.match(a.id, /^r_[0-9a-z]{7,}$/);
    assert.notEqual(ruleIdFor("exact", "/x"), ruleIdFor("exact", "/x", "a.test"));
  });
  it("parses utm strings and booleans", () => {
    const r = normalizeRule({ source: "/x", destination: "/y", utm: "utm_source=a&medium=b", enabled: "no", caseSensitive: "1" });
    assert.deepEqual(r.utm, { source: "a", medium: "b" });
    assert.equal(r.enabled, false);
    assert.equal(r.caseSensitive, true);
  });
  it("isActive respects enabled and windows", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(isActive(rule({ source: "/a", destination: "/b" }), now), true);
    assert.equal(isActive(rule({ source: "/a", destination: "/b", enabled: false }), now), false);
    assert.equal(isActive(rule({ source: "/a", destination: "/b", expiresAt: "2025-12-31" }), now), false);
  });
});

describe("export formats", () => {
  const rules = [
    rule({ id: "one", source: "/a", destination: "https://x.test/?q=1,2", note: 'say "hi"', utm_source: "s" }),
    rule({ id: "two", source: "/b/*", destination: "/c/$1", status: 302 }),
  ];

  it("CSV round-trips", () => {
    const csv = toCsv(rules);
    assert.match(csv.split("\n")[0], /^id,type,source,destination,status/);
    const back = parseCsv(csv).rules;
    assert.deepEqual(back, rules);
  });

  it("builds a wrangler kv bulk file", () => {
    const bulk = toKvBulk(rules, new Date("2026-01-01T00:00:00Z"));
    assert.equal(bulk.length, 1);
    assert.equal(bulk[0].key, RULESET_KEY);
    const doc = JSON.parse(bulk[0].value);
    assert.equal(doc.version, 1);
    assert.equal(doc.updatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(doc.rules.length, 2);
    assert.deepEqual(bulk[0].metadata, { count: 2, updatedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("diffs by id", () => {
    const after = [{ ...rules[0], destination: "/changed" }, rule({ id: "three", source: "/z", destination: "/y" })];
    const d = diffRules(rules, after);
    assert.deepEqual(d.added.map((r) => r.id), ["three"]);
    assert.deepEqual(d.removed.map((r) => r.id), ["two"]);
    assert.deepEqual(d.changed.map((c) => [c.after.id, c.fields]), [["one", ["destination"]]]);
    assert.equal(d.unchanged, 0);
    assert.equal(diffRules(rules, rules).unchanged, 2);
  });
});
