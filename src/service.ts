import { handleAdmin } from "./admin.js";
import { configFromEnv, type Config } from "./config.js";
import { counterFromEnv, type ClickCounter } from "./counters.js";
import { newTrace, Router } from "./router.js";
import { storeFromEnv, type RuleStore } from "./storage.js";
import type { Env, ExecutionContextLike, MatchResult, Rule, RuleSetDocument } from "./types.js";

export interface LoadedRules {
  doc: RuleSetDocument | null;
  router: Router;
  loadedAt: number;
}

export interface ServiceDeps {
  now?: () => number;
}

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export function redirectResponse(match: MatchResult): Response {
  const permanent = match.status === 301 || match.status === 308;
  return new Response(null, {
    status: match.status,
    headers: {
      location: match.location,
      // Short browser cache for permanent redirects limits the blast radius of a bad rule.
      "cache-control": permanent ? "public, max-age=3600" : "no-store",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

/**
 * Holds the compiled rule set for one isolate. Rules are reloaded from storage
 * after `cacheTtl` seconds, or immediately after an admin write in the same isolate.
 */
export class RedirectService {
  private cache: LoadedRules | null = null;
  private loading: Promise<LoadedRules> | null = null;
  readonly now: () => number;

  constructor(deps: ServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  invalidate(): void {
    this.cache = null;
  }

  compile(rules: Rule[], config: Config): Router {
    return new Router(rules, { allowRegex: config.allowRegex, regexBudgetMs: config.regexBudgetMs });
  }

  async rules(store: RuleStore, config: Config): Promise<LoadedRules> {
    const fresh = this.cache && this.now() - this.cache.loadedAt < config.cacheTtl * 1000;
    if (fresh && this.cache) return this.cache;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const doc = await store.load();
          const loaded = { doc, router: this.compile(doc?.rules ?? [], config), loadedAt: this.now() };
          this.cache = loaded;
          return loaded;
        } finally {
          this.loading = null;
        }
      })();
    }
    return this.loading;
  }

  setCache(doc: RuleSetDocument, config: Config): void {
    this.cache = { doc, router: this.compile(doc.rules, config), loadedAt: this.now() };
  }

  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    const config = configFromEnv(env);
    const url = new URL(request.url);

    if (url.pathname === config.adminPath || url.pathname.startsWith(`${config.adminPath}/`)) {
      return handleAdmin(request, env, config, this);
    }

    let store: RuleStore;
    let counter: ClickCounter;
    try {
      store = storeFromEnv(env);
      counter = counterFromEnv(env);
    } catch (e) {
      return json({ error: "misconfigured", detail: (e as Error).message }, 500);
    }

    const { router } = await this.rules(store, config);
    const trace = newTrace();
    const match = router.match(url, this.now(), trace);

    if (match) {
      const record = counter
        .record(match, {
          url,
          country: (request as Request & { cf?: { country?: string } }).cf?.country,
          referer: request.headers.get("referer"),
          userAgent: request.headers.get("user-agent"),
        })
        .catch(() => undefined);
      if (ctx) ctx.waitUntil(record);
      else await record;
      return redirectResponse(match);
    }

    switch (config.fallback) {
      case "passthrough":
        return fetch(request);
      case "redirect":
        if (config.fallbackUrl) {
          return new Response(null, { status: 302, headers: { location: config.fallbackUrl, "cache-control": "no-store" } });
        }
        break;
      default:
        break;
    }
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" },
    });
  }
}
