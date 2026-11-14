import { isAbsoluteHttp } from "./location.js";
import { compilePrefixPattern, PatternError, referencedPlaceholders } from "./pattern.js";
import { Router } from "./router.js";
import { isKnownQueryMode, isKnownType, slotKey } from "./rules.js";
import { checkRegexSafety } from "./saferegex.js";
import { UTM_KEYS, VALID_STATUSES, type Rule } from "./types.js";

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  code: string;
  ruleId?: string;
  message: string;
  /** For chains: the hops followed, starting with the source. */
  path?: string[];
}

export interface ValidationReport {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: Issue[];
}

export interface ValidateOptions {
  allowRegex?: boolean;
  /** Hosts considered "this site" when following absolute destinations for loop/chain detection. */
  internalHosts?: string[];
  /** Maximum number of rules accepted. */
  maxRules?: number;
  /** Maximum hops followed when detecting chains. */
  maxHops?: number;
  /** Clock for expiry warnings. */
  now?: number;
  ignoreTrailingSlash?: boolean;
}

export const DEFAULT_MAX_RULES = 50_000;
const SAMPLE_HOST = "redirects.internal";

/** Build a concrete path that the rule's source matches, for loop simulation. */
export function samplePathFor(rule: Rule): string | null {
  if (rule.type === "exact") return rule.source;
  if (rule.type === "prefix") {
    return rule.source.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "sample-$1").replace(/\*/g, "sample");
  }
  return null; // regex sources are not invertible
}

function destinationPath(dest: string, internalHosts: Set<string>): string | null {
  if (dest.startsWith("/") && !dest.startsWith("//")) return dest;
  if (!isAbsoluteHttp(dest)) return null;
  try {
    const u = new URL(dest);
    if (internalHosts.has(u.hostname.toLowerCase())) return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
  return null;
}

function maxPositional(rule: Rule): { count: number; names: string[] } | null {
  try {
    if (rule.type === "prefix") {
      const c = compilePrefixPattern(rule.source, rule.caseSensitive ?? false);
      return { count: c.names.length, names: c.names };
    }
    if (rule.type === "regex") {
      const re = new RegExp(`${rule.source}|`);
      const m = re.exec("");
      const names = m?.groups ? Object.keys(m.groups) : [];
      return { count: (m?.length ?? 1) - 1, names };
    }
    return { count: 0, names: [] };
  } catch {
    return null;
  }
}

/**
 * Validate a rule set. Never throws: every problem becomes an Issue.
 *
 * Errors block a deploy/import; warnings are informational.
 */
export function validateRules(rules: readonly Rule[], options: ValidateOptions = {}): ValidationReport {
  const issues: Issue[] = [];
  const now = options.now ?? Date.now();
  const internalHosts = new Set((options.internalHosts ?? []).map((h) => h.toLowerCase()));
  const maxRules = options.maxRules ?? DEFAULT_MAX_RULES;
  const maxHops = options.maxHops ?? 10;
  const err = (code: string, message: string, ruleId?: string, path?: string[]) =>
    issues.push({ severity: "error", code, message, ruleId, ...(path ? { path } : {}) });
  const warn = (code: string, message: string, ruleId?: string, path?: string[]) =>
    issues.push({ severity: "warning", code, message, ruleId, ...(path ? { path } : {}) });

  if (rules.length > maxRules) err("too_many_rules", `${rules.length} rules exceeds the limit of ${maxRules}`);

  const ids = new Map<string, number>();
  const slots = new Map<string, Rule>();
  const structurallyValid: Rule[] = [];

  for (const rule of rules) {
    let valid = true;
    const id = rule.id;
    if (!id || typeof id !== "string") {
      err("missing_id", "rule has no id");
      valid = false;
    } else {
      ids.set(id, (ids.get(id) ?? 0) + 1);
      if (ids.get(id) === 2) err("duplicate_id", `id "${id}" is used more than once`, id);
    }

    if (!isKnownType(String(rule.type))) {
      err("invalid_type", `unknown type "${String(rule.type)}" (expected exact, prefix or regex)`, id);
      valid = false;
    }
    if (!(VALID_STATUSES as readonly number[]).includes(rule.status)) {
      err("invalid_status", `status ${String(rule.status)} is not a redirect status (use 301, 302, 307 or 308)`, id);
      valid = false;
    }
    if (!isKnownQueryMode(String(rule.query))) {
      err("invalid_query_mode", `query mode "${String(rule.query)}" must be preserve or strip`, id);
      valid = false;
    }

    // Source checks per type.
    if (rule.type === "exact" || rule.type === "prefix") {
      if (typeof rule.source !== "string" || !rule.source.startsWith("/")) {
        err("invalid_source", `source "${String(rule.source)}" must start with "/"`, id);
        valid = false;
      } else if (rule.type === "prefix") {
        try {
          compilePrefixPattern(rule.source, rule.caseSensitive ?? false);
        } catch (e) {
          err("invalid_source", e instanceof PatternError ? e.message : String(e), id);
          valid = false;
        }
      } else if (/[*]/.test(rule.source)) {
        warn("exact_with_wildcard", `exact source "${rule.source}" contains "*"; did you mean type "prefix"?`, id);
      }
    } else if (rule.type === "regex") {
      if (!options.allowRegex) {
        err("regex_disabled", "regex rules are disabled; enable them explicitly (ENABLE_REGEX / --allow-regex)", id);
        valid = false;
      }
      const check = checkRegexSafety(String(rule.source));
      if (!check.ok) {
        err("unsafe_regex", `regex rejected: ${check.reason}`, id);
        valid = false;
      }
    }

    // Destination checks.
    const dest = String(rule.destination ?? "");
    if (/[\r\n\t\0]/.test(dest)) {
      err("invalid_destination", "destination contains control characters", id);
      valid = false;
    } else if (dest.startsWith("//") || dest.startsWith("/\\")) {
      err("invalid_destination", "protocol-relative destinations are not allowed", id);
      valid = false;
    } else if (!dest.startsWith("/") && !isAbsoluteHttp(dest)) {
      err("invalid_destination", `destination "${dest}" must be an absolute http(s) URL or start with "/"`, id);
      valid = false;
    } else if (isAbsoluteHttp(dest)) {
      try {
        new URL(dest.replace(/\$\d{1,2}|\$<\w+>|:[A-Za-z_]\w*/g, "x"));
      } catch {
        err("invalid_destination", `destination "${dest}" is not a valid URL`, id);
        valid = false;
      }
    }

    // Placeholder references must exist in the source.
    if (valid && rule.type !== "exact") {
      const caps = maxPositional(rule);
      const refs = referencedPlaceholders(dest);
      if (caps) {
        for (const n of refs.positional) {
          if (n > caps.count) {
            err("unknown_placeholder", `destination uses $${n} but the source has ${caps.count} capture(s)`, id);
          }
        }
        for (const n of refs.named) {
          if (!caps.names.includes(n)) err("unknown_placeholder", `destination uses $<${n}> which the source does not capture`, id);
        }
      }
    } else if (valid && /\$\d|\$<\w+>/.test(dest)) {
      warn("placeholder_in_exact", "exact rules have no captures; $n placeholders will be empty", id);
    }

    // Dates.
    for (const field of ["expiresAt", "startsAt"] as const) {
      const v = rule[field];
      if (v !== undefined && Number.isNaN(Date.parse(v))) {
        err("invalid_date", `${field} "${v}" is not a valid ISO-8601 date`, id);
        valid = false;
      }
    }
    if (rule.expiresAt && rule.startsAt && Date.parse(rule.startsAt) >= Date.parse(rule.expiresAt)) {
      err("invalid_window", "startsAt must be before expiresAt", id);
    }
    if (rule.expiresAt && Date.parse(rule.expiresAt) <= now) warn("expired", `rule expired at ${rule.expiresAt}`, id);

    // UTM keys.
    if (rule.utm) {
      for (const k of Object.keys(rule.utm)) {
        if (!(UTM_KEYS as readonly string[]).includes(k)) warn("unknown_utm_key", `unknown UTM key "${k}"`, id);
      }
    }
    if (rule.host && !/^(\*\.)?[a-z0-9.-]+$/.test(rule.host)) {
      err("invalid_host", `host "${rule.host}" is not a hostname or *.wildcard`, id);
      valid = false;
    }
    if (rule.status === 302 || rule.status === 307) {
      // fine, temporary
    } else if (rule.expiresAt && (rule.status === 301 || rule.status === 308)) {
      warn(
        "permanent_with_expiry",
        "permanent redirects are cached by browsers; an expiring rule usually wants 302 or 307",
        id,
      );
    }

    // Conflicts: same slot with a different target.
    if (valid) {
      const key = slotKey(rule, options.ignoreTrailingSlash ?? true);
      const prev = slots.get(key);
      if (prev && rule.enabled && prev.enabled) {
        if (prev.destination === rule.destination && prev.status === rule.status) {
          warn("duplicate_rule", `same source as rule "${prev.id}" with the same destination`, id);
        } else {
          err(
            "conflicting_rule",
            `source "${rule.source}" is also defined by rule "${prev.id}" with a different destination or status`,
            id,
          );
        }
      } else if (!prev) {
        slots.set(key, rule);
      }
      structurallyValid.push(rule);
    }
  }

  // Loops and chains: simulate requests through the real router.
  const router = new Router(
    structurallyValid.filter((r) => r.enabled),
    { allowRegex: options.allowRegex ?? false, ignoreTrailingSlash: options.ignoreTrailingSlash },
  );
  for (const rule of structurallyValid) {
    if (!rule.enabled) continue;
    const sample = samplePathFor(rule);
    if (sample === null) continue;
    const host = rule.host && !rule.host.startsWith("*.") ? rule.host : SAMPLE_HOST;
    const hops: string[] = [sample];
    const seen = new Set<string>([sample.toLowerCase()]);
    let current = `https://${host}${sample.startsWith("/") ? "" : "/"}${sample}`;
    let first: Rule | null = null;
    for (let hop = 0; hop < maxHops; hop++) {
      const m = router.match(current, now);
      if (!m) break;
      if (hop === 0) {
        first = m.rule;
        if (first.id !== rule.id) break; // shadowed by a more specific rule; not this rule's chain
      }
      const next = destinationPath(m.location, new Set([...internalHosts, host]));
      if (next === null) {
        hops.push(m.location); // leaves the site: final hop
        break;
      }
      hops.push(next);
      const norm = next.toLowerCase().replace(/\/+$/, "") || "/";
      const curPath = new URL(current).pathname.toLowerCase().replace(/\/+$/, "") || "/";
      if (norm === curPath || seen.has(next.toLowerCase())) {
        err("redirect_loop", `redirect loop: ${hops.join(" -> ")}`, rule.id, hops);
        break;
      }
      seen.add(next.toLowerCase());
      current = `https://${host}${next}`;
      if (hop === maxHops - 1) {
        err("chain_too_long", `chain longer than ${maxHops} hops: ${hops.join(" -> ")}`, rule.id, hops);
      }
    }
    if (hops.length > 2 && !issues.some((i) => i.ruleId === rule.id && (i.code === "redirect_loop" || i.code === "chain_too_long"))) {
      warn(
        "redirect_chain",
        `chain of ${hops.length - 1} hops: ${hops.join(" -> ")}; point the rule straight at ${hops[hops.length - 1]}`,
        rule.id,
        hops,
      );
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  return { ok: errors === 0, errors, warnings: issues.length - errors, issues };
}

/** Human-readable multi-line report. */
export function formatReport(report: ValidationReport): string {
  const lines = report.issues.map(
    (i) => `${i.severity === "error" ? "ERROR" : "WARN "} ${i.code.padEnd(22)} ${i.ruleId ?? "-"}  ${i.message}`,
  );
  lines.push(`${report.errors} error(s), ${report.warnings} warning(s)`);
  return lines.join("\n");
}
