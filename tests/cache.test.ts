import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoastCache,
  PROMPT_VERSION,
  makeCacheKey,
  defaultCachePath,
} from "../src/cache.js";

async function tmpPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commit-roast-cache-"));
  return join(dir, "roasts.json");
}

describe("cache.makeCacheKey", () => {
  it("is stable for the same inputs", () => {
    const a = makeCacheKey({ commitSha: "abc", persona: "linus", model: "gpt-4o-mini" });
    const b = makeCacheKey({ commitSha: "abc", persona: "linus", model: "gpt-4o-mini" });
    expect(a).toBe(b);
  });
  it("differs when any field changes", () => {
    const base = { commitSha: "abc", persona: "linus", model: "gpt-4o-mini" };
    expect(makeCacheKey(base)).not.toBe(makeCacheKey({ ...base, persona: "pm" }));
    expect(makeCacheKey(base)).not.toBe(makeCacheKey({ ...base, model: "qwen" }));
    expect(makeCacheKey(base)).not.toBe(makeCacheKey({ ...base, commitSha: "def" }));
  });
});

describe("cache.defaultCachePath", () => {
  it("lands under ~/.commit-roast/cache/", () => {
    expect(defaultCachePath("/home/x")).toBe("/home/x/.commit-roast/cache/roasts.json");
  });
});

describe("RoastCache miss / hit / persist", () => {
  let path: string;
  beforeEach(async () => {
    path = await tmpPath();
  });

  it("returns undefined on first lookup (miss) and records the miss", async () => {
    const cache = new RoastCache({ path });
    const key = makeCacheKey({ commitSha: "1", persona: "linus", model: "m" });
    expect(await cache.get(key)).toBeUndefined();
    const s = await cache.stats();
    expect(s.misses).toBe(1);
    expect(s.hits).toBe(0);
    expect(s.entries).toBe(0);
  });

  it("returns the stored entry on second lookup and survives reload", async () => {
    const cache = new RoastCache({ path });
    const key = makeCacheKey({ commitSha: "1", persona: "linus", model: "m" });
    await cache.set(key, { roast: "hot take", rewrite: "fix: bug" });
    await cache.flush();

    const reopened = new RoastCache({ path });
    const hit = await reopened.get(key);
    expect(hit?.roast).toBe("hot take");
    expect(hit?.rewrite).toBe("fix: bug");
    expect(hit?.promptVersion).toBe(PROMPT_VERSION);

    const s = await reopened.stats();
    expect(s.hits).toBe(1);
    expect(s.entries).toBe(1);
    expect(s.bytes).toBeGreaterThan(0);
  });
});

describe("RoastCache prompt-version invalidation", () => {
  it("ignores entries from a different PROMPT_VERSION and counts them as miss", async () => {
    const path = await tmpPath();
    // Hand-craft a stale entry.
    const stale = {
      version: 1,
      stats: { hits: 0, misses: 0 },
      entries: {
        k: {
          ts: 1,
          promptVersion: PROMPT_VERSION + 999,
          roast: "old",
          rewrite: "old",
        },
      },
    };
    await writeFile(path, JSON.stringify(stale), "utf8");
    const cache = new RoastCache({ path });
    expect(await cache.get("k")).toBeUndefined();
    const s = await cache.stats();
    expect(s.misses).toBe(1);
    // Stale entry was evicted on read.
    expect(s.entries).toBe(0);
  });
});

describe("RoastCache LRU eviction", () => {
  it("trims oldest entries when capacity is exceeded", async () => {
    const path = await tmpPath();
    const cache = new RoastCache({ path, maxEntries: 3 });
    await cache.set("a", { roast: "1", rewrite: "1" });
    await cache.set("b", { roast: "2", rewrite: "2" });
    await cache.set("c", { roast: "3", rewrite: "3" });
    // Touch "a" so it becomes most-recent.
    await cache.get("a");
    await cache.set("d", { roast: "4", rewrite: "4" });
    const snap = cache.snapshot();
    const keys = Object.keys(snap.entries);
    expect(keys).toContain("a");
    expect(keys).toContain("c");
    expect(keys).toContain("d");
    expect(keys).not.toContain("b");
    expect(keys.length).toBe(3);
  });
});

describe("RoastCache clear", () => {
  it("empties entries and resets stats", async () => {
    const path = await tmpPath();
    const cache = new RoastCache({ path });
    await cache.set("k", { roast: "r", rewrite: "x" });
    await cache.get("k");
    await cache.flush();
    await cache.clear();
    const s = await cache.stats();
    expect(s.entries).toBe(0);
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.entries).toEqual({});
  });
});

describe("RoastCache corrupt file recovery", () => {
  it("resets when file isn't valid JSON", async () => {
    const path = await tmpPath();
    await writeFile(path, "not json at all", "utf8");
    const cache = new RoastCache({ path });
    expect(await cache.get("k")).toBeUndefined();
    const s = await cache.stats();
    expect(s.entries).toBe(0);
  });
});

describe("RoastCache hit-rate accounting", () => {
  it("reports hitRate as hits/(hits+misses)", async () => {
    const path = await tmpPath();
    const cache = new RoastCache({ path });
    await cache.set("k", { roast: "r", rewrite: "x" });
    await cache.get("k"); // hit
    await cache.get("k"); // hit
    await cache.get("miss"); // miss
    const s = await cache.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3, 5);
  });
});
