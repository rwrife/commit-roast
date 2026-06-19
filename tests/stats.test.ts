import { describe, it, expect } from "vitest";
import { gradeAll, summarize, sparkline, scoreToGrade, renderStats } from "../src/stats.js";
import type { Commit } from "../src/git.js";

function mkCommit(partial: Partial<Commit>): Commit {
  return {
    sha: "0".repeat(40),
    shortSha: "0000000",
    subject: "",
    body: "",
    author: "alice",
    date: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

const goodSubject = "feat(api): add user lookup endpoint";
const okayishSubject = "fix typo in readme";
const badSubject = "stuff";

describe("sparkline", () => {
  it("returns empty string for empty input", () => {
    expect(sparkline([])).toBe("");
  });

  it("produces one bar character per score", () => {
    const out = sparkline([0, 50, 100]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("▁");
    expect(out[2]).toBe("█");
  });

  it("clamps out-of-range scores", () => {
    expect(sparkline([-50, 9999])).toHaveLength(2);
  });
});

describe("scoreToGrade", () => {
  it.each([
    [95, "A"],
    [89, "B"],
    [70, "C"],
    [60, "D"],
    [10, "F"],
  ] as const)("score %i → %s", (score, grade) => {
    expect(scoreToGrade(score)).toBe(grade);
  });
});

describe("summarize", () => {
  it("handles empty input", () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.average).toBe(0);
    expect(s.sparkline).toBe("");
    expect(s.best).toBeNull();
    expect(s.worst).toBeNull();
  });

  it("computes distribution, best, worst, and per-author stats", () => {
    const commits = [
      mkCommit({ sha: "a".repeat(40), shortSha: "aaaaaaa", subject: goodSubject, author: "alice" }),
      mkCommit({ sha: "b".repeat(40), shortSha: "bbbbbbb", subject: okayishSubject, author: "bob" }),
      mkCommit({ sha: "c".repeat(40), shortSha: "ccccccc", subject: badSubject, author: "bob" }),
    ];
    const summary = summarize(gradeAll(commits));

    expect(summary.total).toBe(3);
    expect(summary.best?.commit.sha).toBe("a".repeat(40));
    expect(summary.worst?.commit.sha).toBe("c".repeat(40));
    expect(summary.sparkline).toHaveLength(3);
    expect(summary.byAuthor.alice.total).toBe(1);
    expect(summary.byAuthor.bob.total).toBe(2);
    // Alice's single good commit should outscore Bob's average.
    expect(summary.byAuthor.alice.average).toBeGreaterThan(summary.byAuthor.bob.average);
    // Distribution counts sum to total.
    const distSum = Object.values(summary.distribution).reduce((a, b) => a + b, 0);
    expect(distSum).toBe(3);
  });
});

describe("renderStats", () => {
  const commits = [
    mkCommit({ sha: "a".repeat(40), shortSha: "aaaaaaa", subject: goodSubject, author: "alice" }),
    mkCommit({ sha: "b".repeat(40), shortSha: "bbbbbbb", subject: badSubject, author: "bob" }),
  ];
  const summary = summarize(gradeAll(commits));

  it("pretty mode renders header, distribution, and best/worst", () => {
    const out = renderStats(summary);
    expect(out).toMatch(/Commits scored: 2/);
    expect(out).toMatch(/Distribution:/);
    expect(out).toMatch(/Best\s+/);
    expect(out).toMatch(/Worst\s+/);
    expect(out).toMatch(/By author:/);
  });

  it("json mode emits parseable JSON with key fields", () => {
    const out = renderStats(summary, { mode: "json" });
    const parsed = JSON.parse(out);
    expect(parsed.total).toBe(2);
    expect(parsed.distribution).toBeDefined();
    expect(parsed.sparkline).toHaveLength(2);
    expect(parsed.best.sha).toBe("a".repeat(40));
    expect(Array.isArray(parsed.byAuthor)).toBe(true);
  });

  it("pretty mode says so when there are no commits", () => {
    const empty = summarize([]);
    expect(renderStats(empty)).toMatch(/No commits/);
  });
});
