import type { Env } from "./types.js";

export type FallbackMode = "404" | "passthrough" | "redirect";

export interface Config {
  adminPath: string;
  allowRegex: boolean;
  regexBudgetMs: number;
  fallback: FallbackMode;
  fallbackUrl?: string;
  /** Seconds a compiled rule set is reused inside one isolate. */
  cacheTtl: number;
  internalHosts: string[];
  maxRules: number;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function num(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v.trim() === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function configFromEnv(env: Env): Config {
  let adminPath = (env.ADMIN_PATH ?? "/__redirects").trim();
  if (!adminPath.startsWith("/")) adminPath = `/${adminPath}`;
  adminPath = adminPath.replace(/\/+$/, "") || "/__redirects";

  const fb = (env.FALLBACK ?? "404").trim().toLowerCase();
  const fallback: FallbackMode = fb === "passthrough" || fb === "redirect" ? fb : "404";

  return {
    adminPath,
    allowRegex: truthy(env.ENABLE_REGEX),
    regexBudgetMs: num(env.REGEX_BUDGET_MS, 5, 1, 50),
    fallback,
    fallbackUrl: env.FALLBACK_URL?.trim() || undefined,
    cacheTtl: num(env.CACHE_TTL, 60, 0, 3600),
    internalHosts: (env.INTERNAL_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    maxRules: num(env.MAX_RULES, 50_000, 1, 500_000),
  };
}
