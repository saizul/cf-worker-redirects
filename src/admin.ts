/**
 * Admin API. Everything except /health requires `Authorization: Bearer <ADMIN_TOKEN>`.
 *
 *   GET    {admin}/health                   liveness + rule count (no auth)
 *   GET    {admin}/api/rules                current rule set
 *   PUT    {admin}/api/rules                replace all rules     body: {rules:[...]} | [...]
 *   POST   {admin}/api/rules                upsert rules by id    body: {rules:[...]} | [...] | {...}
 *   DELETE {admin}/api/rules/:id            delete one rule
 *   POST   {admin}/api/import?format=csv|json&mode=replace|merge&dryRun=1   raw CSV/JSON body
 *   GET    {admin}/api/export?format=csv|json
 *   POST   {admin}/api/validate             validate without saving
 *   GET    {admin}/api/test?url=...         which rule matches a URL
 *   GET    {admin}/api/stats                click counters (COUNTER=kv)
 */
import { authorize } from "./auth.js";
import type { Config } from "./config.js";
import { counterFromEnv } from "./counters.js";
import { normalizeAll, parseRules, toCsv } from "./io.js";
import { newTrace } from "./router.js";
import { json, type RedirectService } from "./service.js";
import { storeFromEnv } from "./storage.js";
import type { Env, Rule, RuleInput } from "./types.js";
import { validateRules } from "./validate.js";

export const MAX_BODY_BYTES = 25 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

async function readText(request: Request): Promise<string> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  return text;
}

async function readRules(request: Request): Promise<Rule[]> {
  const text = await readText(request);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  let list: unknown;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object" && Array.isArray((data as { rules?: unknown }).rules)) {
    list = (data as { rules: unknown[] }).rules;
  } else if (data && typeof data === "object") list = [data];
  const parsed = normalizeAll(list as RuleInput[]);
  if (parsed.errors.length) {
    throw new HttpError(400, "invalid rule input", { errors: parsed.errors.map((e) => e.message) });
  }
  return parsed.rules;
}

function mergeRules(existing: Rule[], incoming: Rule[]): Rule[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()];
}

export async function handleAdmin(
  request: Request,
  env: Env,
  config: Config,
  service: RedirectService,
): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice(config.adminPath.length) || "/";
  const method = request.method.toUpperCase();

  try {
    const store = storeFromEnv(env);

    if (sub === "/health" && (method === "GET" || method === "HEAD")) {
      const { doc, router } = await service.rules(store, config);
      return json({ ok: true, storage: store.kind, rules: router.size, updatedAt: doc?.updatedAt ?? null });
    }

    const auth = await authorize(request.headers.get("authorization"), env.ADMIN_TOKEN);
    if (!auth.ok) {
      return json({ error: auth.reason }, auth.status, auth.status === 401 ? { "www-authenticate": "Bearer" } : {});
    }

    const validateOpts = {
      allowRegex: config.allowRegex,
      internalHosts: [...config.internalHosts, url.hostname],
      maxRules: config.maxRules,
      now: service.now(),
    };

    const save = async (rules: Rule[], dryRun: boolean) => {
      const report = validateRules(rules, validateOpts);
      if (!report.ok) return json({ saved: false, report }, 422);
      if (dryRun) return json({ saved: false, dryRun: true, count: rules.length, report });
      const doc = await store.save(rules);
      service.setCache(doc, config);
      return json({ saved: true, count: rules.length, updatedAt: doc.updatedAt, report });
    };

    const dryRun = ["1", "true", "yes"].includes((url.searchParams.get("dryRun") ?? "").toLowerCase());

    if (sub === "/api/rules") {
      if (method === "GET") {
        const { doc } = await service.rules(store, config);
        return json(doc ?? { version: 1, updatedAt: null, rules: [] });
      }
      if (method === "PUT") return save(await readRules(request), dryRun);
      if (method === "POST") {
        const incoming = await readRules(request);
        const current = (await store.load())?.rules ?? [];
        return save(mergeRules(current, incoming), dryRun);
      }
      throw new HttpError(405, "method not allowed");
    }

    if (sub.startsWith("/api/rules/")) {
      const id = decodeURIComponent(sub.slice("/api/rules/".length));
      const current = (await store.load())?.rules ?? [];
      const rule = current.find((r) => r.id === id);
      if (method === "GET") return rule ? json(rule) : json({ error: "not found" }, 404);
      if (method === "DELETE") {
        if (!rule) return json({ error: "not found" }, 404);
        return save(
          current.filter((r) => r.id !== id),
          dryRun,
        );
      }
      throw new HttpError(405, "method not allowed");
    }

    if (sub === "/api/import" && method === "POST") {
      const format = url.searchParams.get("format") ?? (request.headers.get("content-type")?.includes("csv") ? "csv" : "json");
      const mode = url.searchParams.get("mode") ?? "replace";
      let parsed;
      try {
        parsed = parseRules(await readText(request), format);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
      if (parsed.errors.length) {
        return json({ saved: false, errors: parsed.errors.map((e) => e.message) }, 400);
      }
      const rules = mode === "merge" ? mergeRules((await store.load())?.rules ?? [], parsed.rules) : parsed.rules;
      return save(rules, dryRun);
    }

    if (sub === "/api/export" && method === "GET") {
      const { doc } = await service.rules(store, config);
      const rules = doc?.rules ?? [];
      if ((url.searchParams.get("format") ?? "json") === "csv") {
        return new Response(toCsv(rules), {
          headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return json(doc ?? { version: 1, updatedAt: null, rules: [] });
    }

    if (sub === "/api/validate" && method === "POST") {
      return json(validateRules(await readRules(request), validateOpts));
    }

    if (sub === "/api/test" && (method === "GET" || method === "POST")) {
      let target = url.searchParams.get("url");
      if (!target && method === "POST") target = (JSON.parse(await readText(request)) as { url?: string }).url ?? null;
      if (!target) throw new HttpError(400, "url is required");
      let testUrl: URL;
      try {
        testUrl = new URL(target, url.origin);
      } catch {
        throw new HttpError(400, "url is not valid");
      }
      const { router } = await service.rules(store, config);
      const trace = newTrace();
      const m = router.match(testUrl, service.now(), trace);
      return json({
        url: testUrl.href,
        matched: Boolean(m),
        ...(m ? { ruleId: m.rule.id, status: m.status, location: m.location, rule: m.rule } : {}),
        trace,
      });
    }

    if (sub === "/api/stats" && method === "GET") {
      const counter = counterFromEnv(env);
      if (!counter.read) {
        return json({ counter: counter.kind, note: "use the Analytics Engine SQL API to query clicks" });
      }
      const ids = url.searchParams.get("ids")?.split(",").filter(Boolean);
      return json({ counter: counter.kind, clicks: await counter.read(ids) });
    }

    throw new HttpError(404, "unknown admin endpoint");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.body as object) }, e.status);
    return json({ error: "internal error", detail: (e as Error).message }, 500);
  }
}
