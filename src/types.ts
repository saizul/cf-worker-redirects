/**
 * Shared types for cf-worker-redirects.
 *
 * The binding interfaces below are deliberately minimal structural types so the
 * routing core compiles and runs under plain Node.js (tests, CLI) without the
 * Workers runtime type package. Real Cloudflare bindings satisfy them.
 */

export type RuleType = "exact" | "prefix" | "regex";
export type RedirectStatus = 301 | 302 | 307 | 308;
export type QueryMode = "preserve" | "strip";

export const VALID_STATUSES: readonly RedirectStatus[] = [301, 302, 307, 308];
export const RULE_TYPES: readonly RuleType[] = ["exact", "prefix", "regex"];
export const QUERY_MODES: readonly QueryMode[] = ["preserve", "strip"];
export const UTM_KEYS = ["source", "medium", "campaign", "term", "content", "id"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;

/** A redirect rule as stored and exchanged (import/export, admin API). */
export interface Rule {
  /** Stable identifier. Generated from the source when omitted on import. */
  id: string;
  /** Matching strategy. */
  type: RuleType;
  /**
   * Path to match.
   * - exact:  "/old-page"
   * - prefix: "/blog/*", "/docs/:section/*", "/shop" (matches "/shop" and "/shop/...")
   * - regex:  "^/p/(\\d+)$" (only when regex rules are enabled)
   */
  source: string;
  /** Absolute http(s) URL or a path starting with "/". May contain $1, :name, $<name> placeholders. */
  destination: string;
  /** HTTP status code. Defaults to 301. */
  status: RedirectStatus;
  /** Restrict the rule to one host ("example.com") or a wildcard ("*.example.com"). */
  host?: string;
  /** What to do with the incoming query string. Defaults to "preserve". */
  query: QueryMode;
  /** UTM parameters appended to the destination when absent. */
  utm?: Utm;
  /** ISO-8601 instant after which the rule stops matching. */
  expiresAt?: string;
  /** ISO-8601 instant before which the rule does not match. */
  startsAt?: string;
  /** Case-sensitive path matching. Defaults to false. */
  caseSensitive?: boolean;
  /** Disabled rules are kept but never match. Defaults to true. */
  enabled: boolean;
  /** Free-form note for humans. */
  note?: string;
}

/** Loose input shape accepted from CSV/JSON before normalisation. */
export type RuleInput = Partial<Record<keyof Rule, unknown>> & Record<string, unknown>;

export interface RuleSetDocument {
  version: 1;
  updatedAt: string;
  rules: Rule[];
}

export interface MatchResult {
  rule: Rule;
  location: string;
  status: RedirectStatus;
}

export interface RouterOptions {
  /** Allow regex rules. Off by default. */
  allowRegex?: boolean;
  /** Max path length evaluated against regex rules. */
  regexMaxInput?: number;
  /** Total wall-clock budget in ms for evaluating regex rules on one request. */
  regexBudgetMs?: number;
  /** Treat "/a" and "/a/" as the same path for exact rules. Defaults to true. */
  ignoreTrailingSlash?: boolean;
}

/* ----- Minimal binding shapes (compatible with the Workers runtime) ----- */

export interface KVLike {
  get(key: string, options?: { type?: "text"; cacheTtl?: number }): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(query: string): D1PreparedLike;
}

export interface AnalyticsEngineLike {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  REDIRECTS?: KVLike;
  DB?: D1Like;
  CLICKS?: AnalyticsEngineLike;
  ADMIN_TOKEN?: string;
  ADMIN_PATH?: string;
  STORAGE?: string;
  COUNTER?: string;
  ENABLE_REGEX?: string;
  REGEX_BUDGET_MS?: string;
  FALLBACK?: string;
  FALLBACK_URL?: string;
  CACHE_TTL?: string;
  INTERNAL_HOSTS?: string;
  MAX_RULES?: string;
}
