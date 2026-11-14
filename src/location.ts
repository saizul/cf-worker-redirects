import { substitute, type Captures } from "./pattern.js";
import type { Rule } from "./types.js";

const PLACEHOLDER_ORIGIN = "https://placeholder.invalid";

export class UnsafeDestinationError extends Error {}

/** True when a destination is an absolute http(s) URL. */
export function isAbsoluteHttp(dest: string): boolean {
  return /^https?:\/\//i.test(dest);
}

/** Basic structural safety check for a (substituted) destination. */
export function assertSafeDestination(dest: string): void {
  if (/[\r\n\t\0]/.test(dest)) throw new UnsafeDestinationError("destination contains control characters");
  if (dest.startsWith("//") || dest.startsWith("/\\")) {
    throw new UnsafeDestinationError("protocol-relative destinations are not allowed");
  }
  if (!dest.startsWith("/") && !isAbsoluteHttp(dest)) {
    throw new UnsafeDestinationError("destination must be an absolute http(s) URL or a path starting with /");
  }
}

/**
 * Build the Location header value for a matched rule.
 *
 * @param rule        matched rule
 * @param captures    captures from the source match
 * @param requestUrl  incoming request URL
 * @param consumedQueryKeys query keys that were part of the source match and must not be forwarded
 */
export function buildLocation(
  rule: Rule,
  captures: Captures,
  requestUrl: URL,
  consumedQueryKeys: readonly string[] = [],
): string {
  const raw = substitute(rule.destination, captures);
  assertSafeDestination(raw);
  const relative = !isAbsoluteHttp(raw);
  const target = new URL(raw, relative ? PLACEHOLDER_ORIGIN : undefined);

  if (rule.query === "preserve") {
    const existing = new Set(target.searchParams.keys());
    for (const [k, v] of requestUrl.searchParams) {
      if (existing.has(k) || consumedQueryKeys.includes(k)) continue;
      target.searchParams.append(k, v);
    }
  }

  if (rule.utm) {
    for (const [k, v] of Object.entries(rule.utm)) {
      if (v === undefined || v === "") continue;
      const key = `utm_${k}`;
      if (!target.searchParams.has(key)) target.searchParams.set(key, v);
    }
  }

  if (relative) return `${target.pathname}${target.search}${target.hash}`;
  return target.href;
}
