import { describe, it, expect, vi } from "vitest";
import {
  WatchSession,
  formatSessionSummary,
  normalizeInterval,
  MIN_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  type WatchDeps,
} from "../src/watch.js";
import type { Commit } from "../src/git.js";
import type { RoastedCommit } from "../src/bin.js";
import { gradeCommit } from "../src/grader.js";

function mkCommit(partial: Partial<Commit> = {}): Commit {
  return {
    sha: partial.sha ?? "a".repeat(40),
    shortSha: (partial.sha ?? "a".repeat(40)).slice(0, 7),
    subject: partial.subject ?? "feat(api): add user endpoint",
    body: partial.body ?? "",
    author: partial.author ?? "alice",
    date: partial.date ?? "2026-01-01T00:00:00Z",
  };
}

function mkRoasted(commit: Commit): RoastedCommit {
  const grade = gradeCommit(commit);
  return {
    commit,
    grade,
    roast: { roast: "roast text", rewrite: commit.subject, source: "fallback" },
  };
}

function stubDeps(overrides: Partial<WatchDeps> = {}): WatchDeps & {
  roastCalls: string[];
} {
  const roastCalls: string[] = [];
  return {
    getHeadSha: overrides.getHeadSha ?? (async () => null),
    getCommitBySha:
      overrides.getCommitBySha ?? (async (sha: string) => mkCommit({ sha })),
    roastOne:
      overrides.roastOne ??
      (async (commit: Commit) => {
        roastCalls.push(commit.sha);
        return mkRoasted(commit);
      }),
    roastCalls,
  } as WatchDeps & { roastCalls: string[] };
}

describe("normalizeInterval", () => {
  it("returns default for non-numeric input", () => {
    expect(normalizeInterval(undefined)).toBe(DEFAULT_INTERVAL_MS);
    expect(normalizeInterval("abc")).toBe(DEFAULT_INTERVAL_MS);
  });

  it("clamps to minimum", () => {
    expect(normalizeInterval(1)).toBe(MIN_INTERVAL_MS);
    expect(normalizeInterval("50")).toBe(MIN_INTERVAL_MS);
  });

  it("passes through reasonable values", () => {
    expect(normalizeInterval(5000)).toBe(5000);
    expect(normalizeInterval("2500")).toBe(2500);
  });

  it("rejects zero/negative", () => {
    expect(normalizeInterval(0)).toBe(DEFAULT_INTERVAL_MS);
    expect(normalizeInterval(-100)).toBe(DEFAULT_INTERVAL_MS);
  });
});

describe("formatSessionSummary", () => {
  it("pluralizes commits and reports grade", () => {
    expect(formatSessionSummary({ count: 0, averageScore: 0, averageGrade: "F" })).toBe(
      "Watched 0 commits • avg grade F"
    );
    expect(formatSessionSummary({ count: 1, averageScore: 90, averageGrade: "A" })).toBe(
      "Watched 1 commit • avg grade A"
    );
    expect(formatSessionSummary({ count: 3, averageScore: 82, averageGrade: "B" })).toBe(
      "Watched 3 commits • avg grade B"
    );
  });
});

describe("WatchSession.tick", () => {
  it("returns null when HEAD is unknown", async () => {
    const deps = stubDeps({ getHeadSha: async () => null });
    const s = new WatchSession(deps);
    expect(await s.tick()).toBeNull();
    expect(deps.roastCalls).toEqual([]);
  });

  it("roasts a new sha exactly once", async () => {
    const sha = "b".repeat(40);
    const deps = stubDeps({ getHeadSha: async () => sha });
    const s = new WatchSession(deps);
    const first = await s.tick();
    const second = await s.tick();
    expect(first?.commit.sha).toBe(sha);
    expect(second).toBeNull();
    expect(deps.roastCalls).toEqual([sha]);
  });

  it("markSeen prevents an initial-head roast", async () => {
    const sha = "c".repeat(40);
    const deps = stubDeps({ getHeadSha: async () => sha });
    const s = new WatchSession(deps);
    s.markSeen(sha);
    expect(await s.tick()).toBeNull();
    expect(deps.roastCalls).toEqual([]);
  });

  it("roasts each distinct sha exactly once across many ticks", async () => {
    const shas = ["d", "e", "f"].map((c) => c.repeat(40));
    let idx = 0;
    const deps = stubDeps({
      getHeadSha: async () => shas[Math.min(idx, shas.length - 1)] ?? null,
    });
    const s = new WatchSession(deps);
    // Two ticks at each sha to simulate polling faster than commits land.
    for (idx = 0; idx < shas.length; idx++) {
      await s.tick();
      await s.tick();
    }
    expect(deps.roastCalls).toEqual(shas);
    expect(s.seenCount()).toBe(shas.length);
  });

  it("skips when getCommitBySha returns null", async () => {
    const deps = stubDeps({
      getHeadSha: async () => "0".repeat(40),
      getCommitBySha: async () => null,
    });
    const s = new WatchSession(deps);
    expect(await s.tick()).toBeNull();
    // The sha is still marked seen so we don't retry forever.
    expect(s.seenCount()).toBe(1);
  });
});

describe("WatchSession.summary", () => {
  it("reports zeros for empty session", () => {
    const s = new WatchSession(stubDeps());
    expect(s.summary()).toEqual({ count: 0, averageScore: 0, averageGrade: "F" });
  });

  it("averages roasted commit scores", async () => {
    const commits = [
      mkCommit({ sha: "1".repeat(40), subject: "feat(api): add user lookup endpoint" }),
      mkCommit({ sha: "2".repeat(40), subject: "wip" }),
    ];
    let i = 0;
    const deps = stubDeps({
      getHeadSha: async () => commits[i]?.sha ?? null,
      getCommitBySha: async (sha) => commits.find((c) => c.sha === sha) ?? null,
    });
    const s = new WatchSession(deps);
    for (i = 0; i < commits.length; i++) await s.tick();
    const sum = s.summary();
    expect(sum.count).toBe(2);
    expect(sum.averageScore).toBeGreaterThan(0);
    expect(["A", "B", "C", "D", "F"]).toContain(sum.averageGrade);
  });
});
