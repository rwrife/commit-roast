import { describe, it, expect } from "vitest";
import { gradeCommit } from "../src/grader.js";
import type { Commit } from "../src/git.js";

function mkCommit(partial: Partial<Commit>): Commit {
  return {
    sha: "0".repeat(40),
    shortSha: "0000000",
    subject: "",
    body: "",
    author: "test",
    date: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("gradeCommit", () => {
  it("A grade for a clean Conventional Commit with body", () => {
    const r = gradeCommit(
      mkCommit({
        subject: "feat(grader): add imperative-mood heuristic",
        body: "Detects common past-tense and gerund first words and dings the score.",
      })
    );
    expect(r.grade).toBe("A");
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it("F grade for empty subject", () => {
    const r = gradeCommit(mkCommit({ subject: "" }));
    expect(r.grade).toBe("F");
    expect(r.reasons[0]).toMatch(/empty/);
  });

  it("F grade for lazy subjects like 'wip'", () => {
    const r = gradeCommit(mkCommit({ subject: "wip" }));
    expect(r.grade).toBe("F");
    expect(r.reasons[0]).toMatch(/lazy/);
  });

  it("dings non-imperative mood after type prefix", () => {
    const r = gradeCommit(
      mkCommit({ subject: "feat: added a thing to the thing" })
    );
    expect(r.reasons.some((x) => /non-imperative/.test(x))).toBe(true);
  });

  it("dings missing Conventional Commits prefix", () => {
    const r = gradeCommit(mkCommit({ subject: "make the grader smarter" }));
    expect(r.reasons.some((x) => /Conventional/i.test(x))).toBe(true);
  });

  it("dings subjects that are too long", () => {
    const r = gradeCommit(
      mkCommit({
        subject:
          "feat: this is an absurdly long commit subject that definitely exceeds seventy-two characters of nonsense",
      })
    );
    expect(r.reasons.some((x) => /too long/.test(x))).toBe(true);
  });

  it("dings trailing period in subject", () => {
    const r = gradeCommit(mkCommit({ subject: "feat: add a thing." }));
    expect(r.reasons.some((x) => /period/.test(x))).toBe(true);
  });

  it("rewards a body with a small bonus reason", () => {
    const r = gradeCommit(
      mkCommit({ subject: "fix(cli): handle empty repo", body: "Returns early." })
    );
    expect(r.reasons.some((x) => /body/.test(x))).toBe(true);
  });
});
