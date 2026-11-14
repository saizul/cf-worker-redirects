import { normalizeRule } from "../src/rules.js";
import type { AnalyticsEngineLike, D1Like, D1PreparedLike, KVLike, Rule, RuleInput } from "../src/types.js";

/** Build a rule with defaults, through the same normaliser the importer uses. */
export function rule(input: RuleInput): Rule {
  return normalizeRule(input);
}

/** In-memory KV namespace with the subset of the API the Worker uses. */
export class MemoryKV implements KVLike {
  readonly data = new Map<string, { value: string; metadata?: unknown }>();
  gets = 0;
  puts = 0;

  async get(key: string): Promise<string | null> {
    this.gets++;
    return this.data.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.puts++;
    this.data.set(key, { value, metadata: options?.metadata });
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const all = [...this.data.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const page = all.slice(start, start + limit);
    const done = start + limit >= all.length;
    return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + limit) };
  }
}

/** Tiny D1 double that understands the two statements the store issues. */
export class MemoryD1 implements D1Like {
  row: { data: string; updated_at: string } | null = null;
  prepare(query: string): D1PreparedLike {
    let bound: unknown[] = [];
    const self = this;
    const stmt: D1PreparedLike = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async first<T>() {
        if (!/^SELECT data FROM ruleset/.test(query)) throw new Error(`unexpected query ${query}`);
        return (self.row as T) ?? null;
      },
      async run() {
        if (!/^INSERT INTO ruleset/.test(query)) throw new Error(`unexpected query ${query}`);
        self.row = { data: String(bound[0]), updated_at: String(bound[1]) };
        return { success: true };
      },
    };
    return stmt;
  }
}

export class MemoryAnalytics implements AnalyticsEngineLike {
  readonly points: { blobs?: string[]; doubles?: number[]; indexes?: string[] }[] = [];
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void {
    this.points.push(point);
  }
}

export const TOKEN = "t".repeat(16) + "0123456789abcdef0123";

export class WaitUntil {
  readonly promises: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>): void {
    this.promises.push(p);
  }
  async flush(): Promise<void> {
    await Promise.all(this.promises);
  }
}
