import { buildLocation, UnsafeDestinationError } from "./location.js";
import { capturesFromMatch, compilePrefixPattern, type Captures } from "./pattern.js";
import { isActive, normalizePath } from "./rules.js";
import { compileSafeRegex } from "./saferegex.js";
import type { MatchResult, Rule, RouterOptions } from "./types.js";

export const DEFAULT_REGEX_MAX_INPUT = 2048;
export const DEFAULT_REGEX_BUDGET_MS = 5;

interface ExactEntry {
  rule: Rule;
  /** Query parameters that must be present (from a source like "/old?id=5"). */
  query: [string, string][];
}

interface PatternEntry {
  rule: Rule;
  regex: RegExp;
  names?: string[];
  literalPrefix: string;
  wildcardCount: number;
  order: number;
}

export interface CompileProblem {
  ruleId: string;
  message: string;
}

export interface MatchTrace {
  /** Regex rules skipped because the per-request budget ran out. */
  regexSkipped: number;
  /** Rules that matched but produced an unsafe destination. */
  unsafe: string[];
}

function hostMatches(ruleHost: string | undefined, host: string): boolean {
  if (!ruleHost) return true;
  if (ruleHost.startsWith("*.")) {
    const suffix = ruleHost.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return ruleHost === host;
}

/**
 * A compiled, immutable rule set. Construction does all the expensive work so
 * per-request matching is a map lookup plus a short ordered scan.
 */
export class Router {
  readonly problems: CompileProblem[] = [];
  readonly size: number;
  private readonly exactSensitive = new Map<string, ExactEntry[]>();
  private readonly exactInsensitive = new Map<string, ExactEntry[]>();
  private readonly prefixes: PatternEntry[] = [];
  private readonly regexes: PatternEntry[] = [];
  private readonly opts: Required<RouterOptions>;

  constructor(rules: readonly Rule[], options: RouterOptions = {}) {
    this.opts = {
      allowRegex: options.allowRegex ?? false,
      regexMaxInput: options.regexMaxInput ?? DEFAULT_REGEX_MAX_INPUT,
      regexBudgetMs: options.regexBudgetMs ?? DEFAULT_REGEX_BUDGET_MS,
      ignoreTrailingSlash: options.ignoreTrailingSlash ?? true,
    };
    let order = 0;
    for (const rule of rules) {
      order++;
      try {
        this.add(rule, order);
      } catch (err) {
        this.problems.push({ ruleId: rule.id, message: (err as Error).message });
      }
    }
    this.prefixes.sort(
      (a, b) =>
        b.literalPrefix.length - a.literalPrefix.length ||
        a.wildcardCount - b.wildcardCount ||
        a.order - b.order,
    );
    this.size = rules.length - this.problems.length;
  }

  private add(rule: Rule, order: number): void {
    const cs = rule.caseSensitive ?? false;
    switch (rule.type) {
      case "exact": {
        const qIdx = rule.source.indexOf("?");
        const path = qIdx >= 0 ? rule.source.slice(0, qIdx) : rule.source;
        if (!path.startsWith("/")) throw new Error(`exact source must start with "/": ${rule.source}`);
        const query = qIdx >= 0 ? [...new URLSearchParams(rule.source.slice(qIdx + 1))] : [];
        const key = normalizePath(path, this.opts.ignoreTrailingSlash, cs);
        const map = cs ? this.exactSensitive : this.exactInsensitive;
        const list = map.get(key) ?? [];
        list.push({ rule, query });
        // Rules with more query constraints are more specific and checked first.
        list.sort((a, b) => b.query.length - a.query.length);
        map.set(key, list);
        return;
      }
      case "prefix": {
        const c = compilePrefixPattern(rule.source, cs);
        this.prefixes.push({
          rule,
          regex: c.regex,
          names: c.names,
          literalPrefix: c.literalPrefix,
          wildcardCount: c.wildcardCount,
          order,
        });
        return;
      }
      case "regex": {
        if (!this.opts.allowRegex) throw new Error("regex rules are disabled (set ENABLE_REGEX=true)");
        const regex = compileSafeRegex(rule.source, cs);
        this.regexes.push({ rule, regex, literalPrefix: "", wildcardCount: 0, order });
        return;
      }
      default:
        throw new Error(`unknown rule type: ${String((rule as Rule).type)}`);
    }
  }

  /**
   * Find the redirect for a URL, or null.
   * @param now  epoch ms used for expiry checks (injectable for tests)
   */
  match(input: URL | string, now = Date.now(), trace?: MatchTrace): MatchResult | null {
    const url = typeof input === "string" ? new URL(input) : input;
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    // 1. Exact rules (case-sensitive table first, then case-insensitive).
    for (const [map, cs] of [
      [this.exactSensitive, true],
      [this.exactInsensitive, false],
    ] as const) {
      const list = map.get(normalizePath(path, this.opts.ignoreTrailingSlash, cs));
      if (!list) continue;
      for (const entry of list) {
        const { rule } = entry;
        if (!isActive(rule, now) || !hostMatches(rule.host, host)) continue;
        if (!entry.query.every(([k, v]) => url.searchParams.get(k) === v)) continue;
        const result = this.finish(rule, { positional: [], named: {} }, url, entry.query.map(([k]) => k), trace);
        if (result) return result;
      }
    }

    // 2. Prefix / wildcard rules, most specific first.
    for (const entry of this.prefixes) {
      const { rule } = entry;
      if (!isActive(rule, now) || !hostMatches(rule.host, host)) continue;
      const m = entry.regex.exec(path);
      if (!m) continue;
      const result = this.finish(rule, capturesFromMatch(m, entry.names), url, [], trace);
      if (result) return result;
    }

    // 3. Regex rules in declaration order, under an input cap and time budget.
    if (this.regexes.length > 0 && path.length <= this.opts.regexMaxInput) {
      const started = Date.now();
      for (let i = 0; i < this.regexes.length; i++) {
        if (Date.now() - started > this.opts.regexBudgetMs) {
          if (trace) trace.regexSkipped += this.regexes.length - i;
          break;
        }
        const entry = this.regexes[i];
        const { rule } = entry;
        if (!isActive(rule, now) || !hostMatches(rule.host, host)) continue;
        const m = entry.regex.exec(path);
        if (!m) continue;
        const result = this.finish(rule, capturesFromMatch(m), url, [], trace);
        if (result) return result;
      }
    }
    return null;
  }

  private finish(
    rule: Rule,
    captures: Captures,
    url: URL,
    consumed: string[],
    trace?: MatchTrace,
  ): MatchResult | null {
    try {
      return { rule, status: rule.status, location: buildLocation(rule, captures, url, consumed) };
    } catch (err) {
      if (err instanceof UnsafeDestinationError || err instanceof TypeError) {
        trace?.unsafe.push(rule.id);
        return null;
      }
      throw err;
    }
  }
}

export function newTrace(): MatchTrace {
  return { regexSkipped: 0, unsafe: [] };
}
