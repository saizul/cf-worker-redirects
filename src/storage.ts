/**
 * Rule-set persistence. The whole rule set is stored as one JSON document so a
 * request costs at most one storage read (and usually zero, thanks to the
 * in-isolate cache). KV values may be up to 25 MiB, which is roughly 100k rules.
 */
import { RULESET_KEY, toDocument } from "./io.js";
import type { D1Like, Env, KVLike, Rule, RuleSetDocument } from "./types.js";

export interface RuleStore {
  readonly kind: "kv" | "d1";
  load(): Promise<RuleSetDocument | null>;
  save(rules: Rule[]): Promise<RuleSetDocument>;
}

function parseDoc(raw: string | null): RuleSetDocument | null {
  if (!raw) return null;
  const doc = JSON.parse(raw) as RuleSetDocument;
  if (doc?.version !== 1 || !Array.isArray(doc.rules)) throw new Error("stored rule set has an unknown format");
  return doc;
}

export class KvRuleStore implements RuleStore {
  readonly kind = "kv" as const;
  constructor(
    private readonly kv: KVLike,
    private readonly cacheTtl = 60,
  ) {}

  async load(): Promise<RuleSetDocument | null> {
    // KV cacheTtl must be >= 30 seconds.
    return parseDoc(await this.kv.get(RULESET_KEY, { type: "text", cacheTtl: Math.max(30, this.cacheTtl) }));
  }

  async save(rules: Rule[]): Promise<RuleSetDocument> {
    const doc = toDocument(rules);
    await this.kv.put(RULESET_KEY, JSON.stringify(doc), {
      metadata: { count: rules.length, updatedAt: doc.updatedAt },
    });
    return doc;
  }
}

/** D1 schema lives in migrations/0001_init.sql. */
export class D1RuleStore implements RuleStore {
  readonly kind = "d1" as const;
  constructor(private readonly db: D1Like) {}

  async load(): Promise<RuleSetDocument | null> {
    const row = await this.db.prepare("SELECT data FROM ruleset WHERE id = 1").first<{ data: string }>();
    return parseDoc(row?.data ?? null);
  }

  async save(rules: Rule[]): Promise<RuleSetDocument> {
    const doc = toDocument(rules);
    await this.db
      .prepare(
        "INSERT INTO ruleset (id, data, updated_at) VALUES (1, ?1, ?2) " +
          "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      )
      .bind(JSON.stringify(doc), doc.updatedAt)
      .run();
    return doc;
  }
}

export function storeFromEnv(env: Env): RuleStore {
  const want = (env.STORAGE ?? (env.DB && !env.REDIRECTS ? "d1" : "kv")).toLowerCase();
  if (want === "d1") {
    if (!env.DB) throw new Error("STORAGE=d1 but no DB binding is configured");
    return new D1RuleStore(env.DB);
  }
  if (!env.REDIRECTS) throw new Error("no REDIRECTS KV binding is configured");
  return new KvRuleStore(env.REDIRECTS, Number(env.CACHE_TTL ?? 60) || 60);
}
