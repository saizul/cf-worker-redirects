/**
 * Import/export of rule sets: CSV (RFC 4180) and JSON, plus the bulk file
 * consumed by `wrangler kv bulk put`.
 */
import { normalizeRule, RuleInputError } from "./rules.js";
import { UTM_KEYS, type Rule, type RuleInput, type RuleSetDocument } from "./types.js";

export const RULESET_KEY = "ruleset:v1";

export interface ParseResult {
  rules: Rule[];
  errors: RuleInputError[];
}

/** Parse RFC 4180 CSV into rows of fields. Handles quotes, escaped quotes and CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === "\r" && src[i + 1] === "\n") i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) throw new Error("CSV: unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop blank lines and comment lines.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === "") && !r[0]?.trimStart().startsWith("#"));
}

const HEADER_ALIASES: Record<string, string> = {
  from: "source",
  to: "destination",
  target: "destination",
  code: "status",
  expires: "expiresAt",
  expires_at: "expiresAt",
  starts: "startsAt",
  starts_at: "startsAt",
  case_sensitive: "caseSensitive",
};

/**
 * Parse CSV. The first row must be a header. Recognised columns:
 * id,type,source,destination,status,host,query,expiresAt,startsAt,caseSensitive,enabled,note,
 * utm_source,utm_medium,utm_campaign,utm_term,utm_content,utm_id.
 * A header-less two or three column file (source,destination[,status]) is also accepted.
 */
export function parseCsv(text: string): ParseResult {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { rules: [], errors: [] };
  let header = rows[0].map((h) => h.trim());
  let body = rows.slice(1);
  const lower = header.map((h) => h.toLowerCase());
  const looksLikeHeader = lower.includes("source") || lower.includes("from") || lower.includes("destination");
  if (!looksLikeHeader) {
    header = ["source", "destination", "status"];
    body = rows;
  } else {
    header = header.map((h) => HEADER_ALIASES[h.toLowerCase()] ?? h);
  }
  const inputs: RuleInput[] = body.map((r) => {
    const obj: RuleInput = {};
    header.forEach((h, idx) => {
      if (r[idx] !== undefined) obj[h] = r[idx];
    });
    return obj;
  });
  return normalizeAll(inputs);
}

/** Parse JSON: an array of rules, or {rules: [...]}. */
export function parseJson(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(data) ? data : (data as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) throw new Error('JSON: expected an array of rules or {"rules": [...]}');
  return normalizeAll(list as RuleInput[]);
}

export function normalizeAll(inputs: RuleInput[]): ParseResult {
  const rules: Rule[] = [];
  const errors: RuleInputError[] = [];
  inputs.forEach((input, idx) => {
    try {
      if (!input || typeof input !== "object") throw new RuleInputError(`row ${idx + 1}: not an object`, idx);
      rules.push(normalizeRule(input, idx));
    } catch (e) {
      errors.push(e instanceof RuleInputError ? e : new RuleInputError(String(e), idx));
    }
  });
  return { rules, errors };
}

/** Pick a parser from a filename or explicit format. */
export function parseRules(text: string, formatOrName: string): ParseResult {
  const f = formatOrName.toLowerCase();
  if (f === "csv" || f.endsWith(".csv")) return parseCsv(text);
  if (f === "json" || f.endsWith(".json")) return parseJson(text);
  // Sniff.
  const t = text.trimStart();
  return t.startsWith("[") || t.startsWith("{") ? parseJson(text) : parseCsv(text);
}

function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const CSV_COLUMNS = [
  "id",
  "type",
  "source",
  "destination",
  "status",
  "host",
  "query",
  "expiresAt",
  "startsAt",
  "caseSensitive",
  "enabled",
  "note",
  ...UTM_KEYS.map((k) => `utm_${k}`),
] as const;

export function toCsv(rules: readonly Rule[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rules) {
    const cells = CSV_COLUMNS.map((col) => {
      if (col.startsWith("utm_")) return r.utm?.[col.slice(4) as keyof NonNullable<Rule["utm"]>] ?? "";
      const v = (r as unknown as Record<string, unknown>)[col];
      return v === undefined ? "" : String(v);
    });
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

export function toDocument(rules: Rule[], now = new Date()): RuleSetDocument {
  return { version: 1, updatedAt: now.toISOString(), rules };
}

export interface KvBulkEntry {
  key: string;
  value: string;
  expiration?: number;
  expiration_ttl?: number;
  metadata?: unknown;
  base64?: boolean;
}

/** Entries for `wrangler kv bulk put <file>`: the whole rule set under one key. */
export function toKvBulk(rules: Rule[], now = new Date()): KvBulkEntry[] {
  const doc = toDocument(rules, now);
  return [
    {
      key: RULESET_KEY,
      value: JSON.stringify(doc),
      metadata: { count: rules.length, updatedAt: doc.updatedAt },
    },
  ];
}

export interface RuleDiff {
  added: Rule[];
  removed: Rule[];
  changed: { before: Rule; after: Rule; fields: (keyof Rule)[] }[];
  unchanged: number;
}

const DIFF_FIELDS: (keyof Rule)[] = [
  "type",
  "source",
  "destination",
  "status",
  "host",
  "query",
  "utm",
  "expiresAt",
  "startsAt",
  "caseSensitive",
  "enabled",
  "note",
];

/** Compare two rule sets by id. */
export function diffRules(before: readonly Rule[], after: readonly Rule[]): RuleDiff {
  const a = new Map(before.map((r) => [r.id, r]));
  const b = new Map(after.map((r) => [r.id, r]));
  const out: RuleDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const [id, r] of b) {
    const prev = a.get(id);
    if (!prev) {
      out.added.push(r);
      continue;
    }
    const fields = DIFF_FIELDS.filter((f) => JSON.stringify(prev[f] ?? null) !== JSON.stringify(r[f] ?? null));
    if (fields.length) out.changed.push({ before: prev, after: r, fields });
    else out.unchanged++;
  }
  for (const [id, r] of a) if (!b.has(id)) out.removed.push(r);
  return out;
}
