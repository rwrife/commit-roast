import { mkdir, readFile, rename, stat, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RoastResult } from "./roaster.js";

/**
 * Bump this whenever the prompt shape, persona contract, or JSON schema
 * sent to the LLM changes in a way that should invalidate prior roasts.
 * Hits with a different version are ignored (and overwritten on next miss).
 */
export const PROMPT_VERSION = 1;

/** Default LRU cap, overridable via `~/.commit-roastrc` (`cacheMaxEntries`). */
export const DEFAULT_MAX_ENTRIES = 1000;

export interface CacheEntry {
  /** Insertion order acts as LRU recency; bumped on hit. */
  ts: number;
  promptVersion: number;
  roast: string;
  rewrite: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export interface CacheFile {
  version: 1;
  stats: CacheStats;
  entries: Record<string, CacheEntry>;
}

export interface RoastCacheOptions {
  path?: string;
  maxEntries?: number;
  home?: string;
}

export interface CacheKeyInput {
  commitSha: string;
  persona: string;
  model: string;
}

export function defaultCachePath(home: string = homedir()): string {
  return join(home, ".commit-roast", "cache", "roasts.json");
}

export function makeCacheKey(input: CacheKeyInput): string {
  // Plain join is enough: shas are hex, persona/model are short identifiers.
  // PROMPT_VERSION is stored on the entry, not in the key, so an old entry
  // can be detected (and overwritten) rather than just shadowed.
  return `${input.commitSha}::${input.persona}::${input.model}`;
}

function emptyCache(): CacheFile {
  return { version: 1, stats: { hits: 0, misses: 0 }, entries: {} };
}

export class RoastCache {
  readonly path: string;
  readonly maxEntries: number;
  private data: CacheFile = emptyCache();
  private loaded = false;
  private dirty = false;

  constructor(opts: RoastCacheOptions = {}) {
    this.path = opts.path ?? defaultCachePath(opts.home);
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  /** Lazy-load; safe to call repeatedly. Corrupt files are reset, not thrown. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        process.stderr.write(
          `commit-roast: cache unreadable (${err instanceof Error ? err.message : err}); starting fresh.\n`
        );
      }
      this.data = emptyCache();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as CacheFile;
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.entries &&
        typeof parsed.entries === "object"
      ) {
        this.data = {
          version: 1,
          stats: {
            hits: Number(parsed.stats?.hits) || 0,
            misses: Number(parsed.stats?.misses) || 0,
          },
          entries: parsed.entries,
        };
        return;
      }
    } catch {
      // fall through
    }
    process.stderr.write(`commit-roast: cache at ${this.path} was corrupt; resetting.\n`);
    this.data = emptyCache();
    this.dirty = true;
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    await this.load();
    const hit = this.data.entries[key];
    if (!hit) {
      this.data.stats.misses += 1;
      this.dirty = true;
      return undefined;
    }
    if (hit.promptVersion !== PROMPT_VERSION) {
      // Stale: treat as miss so the caller writes a fresh entry.
      delete this.data.entries[key];
      this.data.stats.misses += 1;
      this.dirty = true;
      return undefined;
    }
    // Touch for LRU: re-insert to push to the end of insertion order.
    delete this.data.entries[key];
    hit.ts = Date.now();
    this.data.entries[key] = hit;
    this.data.stats.hits += 1;
    this.dirty = true;
    return hit;
  }

  async set(key: string, result: Pick<RoastResult, "roast" | "rewrite">): Promise<void> {
    await this.load();
    this.data.entries[key] = {
      ts: Date.now(),
      promptVersion: PROMPT_VERSION,
      roast: result.roast,
      rewrite: result.rewrite,
    };
    this.evict();
    this.dirty = true;
  }

  private evict(): void {
    const keys = Object.keys(this.data.entries);
    const overflow = keys.length - this.maxEntries;
    if (overflow <= 0) return;
    // Insertion order in a plain object is preserved for string keys;
    // the oldest entries sit at the front.
    for (let i = 0; i < overflow; i += 1) {
      delete this.data.entries[keys[i]!];
    }
  }

  async clear(): Promise<void> {
    this.loaded = true;
    this.data = emptyCache();
    this.dirty = true;
    await this.flush();
  }

  async stats(): Promise<{
    entries: number;
    bytes: number;
    hits: number;
    misses: number;
    hitRate: number;
    path: string;
  }> {
    await this.load();
    let bytes = 0;
    try {
      const s = await stat(this.path);
      bytes = s.size;
    } catch {
      bytes = 0;
    }
    const { hits, misses } = this.data.stats;
    const total = hits + misses;
    return {
      entries: Object.keys(this.data.entries).length,
      bytes,
      hits,
      misses,
      hitRate: total === 0 ? 0 : hits / total,
      path: this.path,
    };
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data), "utf8");
    try {
      await rename(tmp, this.path);
    } catch (err) {
      // Best-effort cleanup; never let a write error escape.
      try {
        await unlink(tmp);
      } catch {
        /* noop */
      }
      process.stderr.write(
        `commit-roast: failed to persist cache (${err instanceof Error ? err.message : err}).\n`
      );
      return;
    }
    this.dirty = false;
  }

  /** Test helper: snapshot current in-memory state. */
  snapshot(): CacheFile {
    return JSON.parse(JSON.stringify(this.data)) as CacheFile;
  }
}
