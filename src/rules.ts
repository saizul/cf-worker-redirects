import {
  QUERY_MODES,
  RULE_TYPES,
  UTM_KEYS,
  type QueryMode,
  type RedirectStatus,
  type Rule,
  type RuleInput,
  type RuleType,
  type Utm,
} from "./types.js";

/** Problems found while turning loose input into a Rule. */
export class RuleInputError extends Error {
  constructor(
    message: string,
    public readonly index: number,
    public readonly field?: string,
  ) {
    super(message);
  }
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === "" ? undefined : s;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

/** Deterministic short id (FNV-1a, base36) so re-imports keep stable ids. */
export function ruleIdFor(type: string, source: string, host?: string): string {
  const text = `${type}|${host ?? ""}|${source}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `r_${h.toString(36).padStart(7, "0")}`;
}

/** Guess the rule type from the source when not given explicitly. */
export function inferType(source: string): RuleType {
  if (source.startsWith("^") || source.endsWith("$")) return "regex";
  if (source.includes("*") || /(^|\/):[A-Za-z_]/.test(source)) return "prefix";
  return "exact";
}

function parseUtm(input: RuleInput): Utm | undefined {
  const utm: Utm = {};
  const nested = input.utm;
  if (nested && typeof nested === "object") {
    for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
      const key = k.replace(/^utm_/, "") as (typeof UTM_KEYS)[number];
      const val = str(v);
      if (val !== undefined) utm[key] = val;
    }
  } else if (typeof nested === "string" && nested.trim() !== "") {
    // "source=newsletter&medium=email" or "utm_source=..."
    for (const [k, v] of new URLSearchParams(nested)) {
      const key = k.replace(/^utm_/, "") as (typeof UTM_KEYS)[number];
      if (v !== "") utm[key] = v;
    }
  }
  // Flat CSV columns: utm_source, utm_medium, ...
  for (const key of UTM_KEYS) {
    const val = str(input[`utm_${key}`]);
    if (val !== undefined) utm[key] = val;
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

/**
 * Normalise one loose input object into a Rule. Throws RuleInputError for
 * structural problems (missing source/destination). Semantic checks such as
 * status codes are left to the validator so all problems are reported at once.
 */
export function normalizeRule(input: RuleInput, index = 0): Rule {
  const source = str(input.source ?? input.from ?? input.path);
  const destination = str(input.destination ?? input.to ?? input.target ?? input.url);
  if (!source) throw new RuleInputError(`row ${index + 1}: missing source`, index, "source");
  if (!destination) throw new RuleInputError(`row ${index + 1}: missing destination`, index, "destination");

  const typeRaw = str(input.type)?.toLowerCase();
  const type = (typeRaw ?? inferType(source)) as RuleType;
  const statusRaw = str(input.status ?? input.code);
  const status = (statusRaw === undefined ? 301 : Number(statusRaw)) as RedirectStatus;
  const queryRaw = str(input.query)?.toLowerCase();
  const query = (queryRaw ?? "preserve") as QueryMode;
  const host = str(input.host)?.toLowerCase();

  const rule: Rule = {
    id: str(input.id) ?? ruleIdFor(type, source, host),
    type,
    source,
    destination,
    status,
    query,
    enabled: bool(input.enabled, true),
  };
  if (host) rule.host = host;
  const utm = parseUtm(input);
  if (utm) rule.utm = utm;
  const expiresAt = str(input.expiresAt ?? input.expires_at ?? input.expires);
  if (expiresAt) rule.expiresAt = expiresAt;
  const startsAt = str(input.startsAt ?? input.starts_at ?? input.starts);
  if (startsAt) rule.startsAt = startsAt;
  const cs = str(input.caseSensitive ?? input.case_sensitive);
  if (cs !== undefined) rule.caseSensitive = bool(cs, false);
  const note = str(input.note ?? input.comment);
  if (note) rule.note = note;
  return rule;
}

export function isKnownType(t: string): t is RuleType {
  return (RULE_TYPES as readonly string[]).includes(t);
}

export function isKnownQueryMode(q: string): q is QueryMode {
  return (QUERY_MODES as readonly string[]).includes(q);
}

/** Is the rule active at the given instant (enabled and inside its time window)? */
export function isActive(rule: Rule, now: number): boolean {
  if (!rule.enabled) return false;
  if (rule.expiresAt) {
    const t = Date.parse(rule.expiresAt);
    if (!Number.isNaN(t) && now >= t) return false;
  }
  if (rule.startsAt) {
    const t = Date.parse(rule.startsAt);
    if (!Number.isNaN(t) && now < t) return false;
  }
  return true;
}

/** Stable key for "same rule slot": type + host + normalised source. */
export function slotKey(rule: Pick<Rule, "type" | "source" | "host" | "caseSensitive">, ignoreTrailingSlash = true): string {
  let src = rule.source;
  if (rule.type === "exact") src = normalizePath(src, ignoreTrailingSlash, rule.caseSensitive ?? false);
  else if (!rule.caseSensitive && rule.type === "prefix") src = src.toLowerCase();
  return `${rule.type}|${rule.host ?? "*"}|${src}`;
}

/** Normalise a path for exact lookups. */
export function normalizePath(path: string, ignoreTrailingSlash: boolean, caseSensitive: boolean): string {
  let p = path;
  try {
    // Decode percent escapes of unreserved characters so "/caf%C3%A9" and "/café" agree.
    p = decodeURI(p);
  } catch {
    // keep raw on malformed escapes
  }
  if (ignoreTrailingSlash && p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "") || "/";
  return caseSensitive ? p : p.toLowerCase();
}
