import { describe, it, expect, vi } from "vitest";
import {
  parsePrUrl,
  fetchPrCommits,
  buildTeamRoast,
  formatTeamComment,
  postTeamComment,
  type GhRunner,
} from "../src/team.js";
import type { Persona } from "../src/personaLoader.js";

const fakePersona: Persona = {
  name: "linus",
  style: "blunt",
  temperature: 0.7,
  prompt: "Be Linus.",
};

describe("parsePrUrl", () => {
  it("parses canonical github URLs", () => {
    expect(parsePrUrl("https://github.com/rwrife/commit-roast/pull/42")).toEqual({
      owner: "rwrife",
      repo: "commit-roast",
      number: 42,
    });
  });

  it("tolerates trailing path segments and query strings", () => {
    expect(
      parsePrUrl("https://github.com/rwrife/commit-roast/pull/42/files?w=1")
    ).toEqual({ owner: "rwrife", repo: "commit-roast", number: 42 });
  });

  it("parses owner/repo#NUM shorthand", () => {
    expect(parsePrUrl("rwrife/commit-roast#7")).toEqual({
      owner: "rwrife",
      repo: "commit-roast",
      number: 7,
    });
  });

  it("parses owner/repo/NUM shorthand", () => {
    expect(parsePrUrl("rwrife/commit-roast/7")).toEqual({
      owner: "rwrife",
      repo: "commit-roast",
      number: 7,
    });
  });

  it("throws on garbage", () => {
    expect(() => parsePrUrl("not a url")).toThrow(/Could not parse/);
    expect(() => parsePrUrl("https://gitlab.com/x/y/pull/1")).toThrow();
  });
});

describe("fetchPrCommits", () => {
  it("maps gh api commit JSON into Commit objects", async () => {
    const runner: GhRunner = vi.fn(async () =>
      JSON.stringify([
        {
          sha: "abcdef1234567890",
          commit: {
            message: "feat: add roast\n\nLonger body here.\n",
            author: { name: "Ada", date: "2026-06-19T00:00:00Z" },
          },
          author: { login: "ada" },
        },
        {
          sha: "1234567890abcdef",
          commit: { message: "wip", author: { name: "Linus" } },
          author: null,
        },
      ])
    );
    const commits = await fetchPrCommits(
      { owner: "x", repo: "y", number: 1 },
      runner
    );
    expect(commits).toHaveLength(2);
    expect(commits[0].subject).toBe("feat: add roast");
    expect(commits[0].body).toBe("Longer body here.");
    expect(commits[0].author).toBe("ada");
    expect(commits[0].shortSha).toBe("abcdef1");
    expect(commits[1].subject).toBe("wip");
    expect(commits[1].body).toBe("");
    expect(commits[1].author).toBe("Linus");
  });

  it("stitches together paginated responses concatenated by gh --paginate", async () => {
    const page1 = JSON.stringify([
      { sha: "a".repeat(40), commit: { message: "one" } },
    ]);
    const page2 = JSON.stringify([
      { sha: "b".repeat(40), commit: { message: "two" } },
    ]);
    const runner: GhRunner = vi.fn(async () => `${page1}${page2}`);
    const commits = await fetchPrCommits(
      { owner: "x", repo: "y", number: 1 },
      runner
    );
    expect(commits.map((c) => c.subject)).toEqual(["one", "two"]);
  });
});

describe("buildTeamRoast", () => {
  it("grades + roasts every commit and averages the score", async () => {
    const runner: GhRunner = async () =>
      JSON.stringify([
        {
          sha: "a".repeat(40),
          commit: { message: "feat(api): add roast endpoint" },
        },
        { sha: "b".repeat(40), commit: { message: "wip" } },
      ]);
    const result = await buildTeamRoast({
      ref: { owner: "x", repo: "y", number: 1 },
      personaName: "linus",
      runner,
      // No API key → fallbackRoast path, deterministic.
      config: { apiKey: undefined },
      loadPersonaImpl: async () => fakePersona,
    });
    expect(result.items).toHaveLength(2);
    expect(result.persona).toBe("linus");
    expect(result.averageScore).toBeGreaterThan(0);
    expect(["A", "B", "C", "D", "F"]).toContain(result.averageGrade);
    // wip commit should grade worse than the conventional one.
    expect(result.items[0].grade.score).toBeGreaterThan(result.items[1].grade.score);
  });

  it("handles empty PRs without dividing by zero", async () => {
    const runner: GhRunner = async () => "[]";
    const result = await buildTeamRoast({
      ref: { owner: "x", repo: "y", number: 1 },
      runner,
      config: { apiKey: undefined },
      loadPersonaImpl: async () => fakePersona,
    });
    expect(result.items).toEqual([]);
    expect(result.averageScore).toBe(0);
  });
});

describe("formatTeamComment", () => {
  it("renders a markdown table and escapes pipe chars", async () => {
    const runner: GhRunner = async () =>
      JSON.stringify([
        {
          sha: "c".repeat(40),
          commit: { message: "fix: handle | pipe in subject" },
        },
      ]);
    const result = await buildTeamRoast({
      ref: { owner: "x", repo: "y", number: 9 },
      runner,
      config: { apiKey: undefined },
      loadPersonaImpl: async () => fakePersona,
    });
    const md = formatTeamComment(result);
    expect(md).toContain("commit-roast");
    expect(md).toContain("| sha | grade | subject |");
    expect(md).toContain("\\|"); // pipe escaped
    expect(md).toMatch(/Average \*\*\d+\/100/);
  });

  it("notes when a PR has no commits", () => {
    const md = formatTeamComment({
      ref: { owner: "x", repo: "y", number: 1 },
      persona: "linus",
      items: [],
      averageScore: 0,
      averageGrade: "F",
    });
    expect(md).toMatch(/No commits to roast/);
  });
});

describe("postTeamComment", () => {
  it("POSTs to the issue comments endpoint and returns html_url", async () => {
    const runner: GhRunner = vi.fn(async () =>
      JSON.stringify({ html_url: "https://github.com/x/y/issues/9#issuecomment-1" })
    );
    const url = await postTeamComment({
      ref: { owner: "x", repo: "y", number: 9 },
      body: "hello",
      runner,
    });
    expect(url).toBe("https://github.com/x/y/issues/9#issuecomment-1");
    expect(runner).toHaveBeenCalledWith([
      "api",
      "-X",
      "POST",
      "repos/x/y/issues/9/comments",
      "-f",
      "body=hello",
    ]);
  });

  it("returns null when the response is not JSON", async () => {
    const runner: GhRunner = async () => "ok";
    const url = await postTeamComment({
      ref: { owner: "x", repo: "y", number: 9 },
      body: "hi",
      runner,
    });
    expect(url).toBeNull();
  });
});
