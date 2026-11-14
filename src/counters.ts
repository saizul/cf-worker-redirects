/**
 * Click counting backends.
 *
 * - "analytics": Workers Analytics Engine. Writes are fire-and-forget, cheap,
 *   and suitable for high volume. Query them with the SQL API.
 * - "kv": a counter per rule in KV. Simple to read back via the admin API but
 *   NOT atomic (read-modify-write) and limited to about one write per second
 *   per key, so counts are approximate under concurrency. Use for low traffic.
 * - "none": disabled (default).
 */
import type { AnalyticsEngineLike, Env, KVLike, MatchResult } from "./types.js";

export const COUNTER_PREFIX = "clicks:";

export interface ClickContext {
  url: URL;
  country?: string;
  referer?: string | null;
  userAgent?: string | null;
}

export interface ClickCounter {
  readonly kind: "none" | "kv" | "analytics";
  record(match: MatchResult, ctx: ClickContext): Promise<void>;
  read?(ruleIds?: string[]): Promise<Record<string, number>>;
}

export class NoopCounter implements ClickCounter {
  readonly kind = "none" as const;
  async record(): Promise<void> {}
}

export class AnalyticsEngineCounter implements ClickCounter {
  readonly kind = "analytics" as const;
  constructor(private readonly dataset: AnalyticsEngineLike) {}

  async record(match: MatchResult, ctx: ClickContext): Promise<void> {
    let refHost = "";
    try {
      refHost = ctx.referer ? new URL(ctx.referer).hostname : "";
    } catch {
      refHost = "";
    }
    // blob order is part of the query contract; see README "Click analytics".
    this.dataset.writeDataPoint({
      indexes: [match.rule.id],
      blobs: [
        match.rule.id,
        ctx.url.hostname,
        ctx.url.pathname.slice(0, 512),
        match.location.slice(0, 512),
        String(match.status),
        ctx.country ?? "",
        refHost,
      ],
      doubles: [1],
    });
  }
}

export class KvCounter implements ClickCounter {
  readonly kind = "kv" as const;
  constructor(private readonly kv: KVLike) {}

  async record(match: MatchResult): Promise<void> {
    const key = COUNTER_PREFIX + match.rule.id;
    const current = Number((await this.kv.get(key)) ?? "0") || 0;
    await this.kv.put(key, String(current + 1));
  }

  async read(ruleIds?: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (ruleIds) {
      await Promise.all(
        ruleIds.map(async (id) => {
          out[id] = Number((await this.kv.get(COUNTER_PREFIX + id)) ?? "0") || 0;
        }),
      );
      return out;
    }
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: COUNTER_PREFIX, cursor, limit: 1000 });
      await Promise.all(
        page.keys.map(async ({ name }) => {
          out[name.slice(COUNTER_PREFIX.length)] = Number((await this.kv.get(name)) ?? "0") || 0;
        }),
      );
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }
}

export function counterFromEnv(env: Env): ClickCounter {
  const mode = (env.COUNTER ?? "none").toLowerCase();
  if (mode === "analytics") {
    if (!env.CLICKS) throw new Error("COUNTER=analytics but no CLICKS Analytics Engine binding is configured");
    return new AnalyticsEngineCounter(env.CLICKS);
  }
  if (mode === "kv") {
    if (!env.REDIRECTS) throw new Error("COUNTER=kv but no REDIRECTS KV binding is configured");
    return new KvCounter(env.REDIRECTS);
  }
  return new NoopCounter();
}
