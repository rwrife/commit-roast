import { describe, it, expect } from "vitest";
import { parsePersonaFile } from "../src/personaLoader.js";
import {
  fallbackRoast,
  roastCommit,
  safeParseRoast,
  resolveConfigFromEnv,
} from "../src/roaster.js";
import type { Commit } from "../src/git.js";

const commit: Commit = {
  sha: "0".repeat(40),
  shortSha: "0000000",
  subject: "fix the thing",
  body: "",
  author: "tester",
  date: "2026-01-01T00:00:00Z",
};

const persona = parsePersonaFile(
  `---\nname: linus\nstyle: blunt\ntemperature: 0.7\n---\nYou are Linus.`,
  "linus"
);

describe("personaLoader.parsePersonaFile", () => {
  it("parses frontmatter + body", () => {
    expect(persona.name).toBe("linus");
    expect(persona.style).toContain("blunt");
    expect(persona.temperature).toBe(0.7);
    expect(persona.prompt).toBe("You are Linus.");
  });

  it("falls back when frontmatter missing", () => {
    const p = parsePersonaFile("just a prompt", "bard");
    expect(p.name).toBe("bard");
    expect(p.temperature).toBe(0.8);
    expect(p.prompt).toBe("just a prompt");
  });
});

describe("roaster.safeParseRoast", () => {
  it("parses clean JSON", () => {
    expect(safeParseRoast('{"roast":"meh","rewrite":"fix: bug"}')).toEqual({
      roast: "meh",
      rewrite: "fix: bug",
    });
  });
  it("strips code fences", () => {
    const r = safeParseRoast('```json\n{"roast":"hi","rewrite":"chore: x"}\n```');
    expect(r?.roast).toBe("hi");
  });
  it("returns null on garbage", () => {
    expect(safeParseRoast("not json")).toBeNull();
    expect(safeParseRoast("")).toBeNull();
  });
});

describe("roaster.fallbackRoast", () => {
  it("returns canned roast + rewrite", () => {
    const r = fallbackRoast(commit, persona, "C");
    expect(r.source).toBe("fallback");
    expect(r.roast).toBeTruthy();
    expect(r.rewrite).toMatch(/^(fix|chore|feat)/);
  });

  it("preserves already-conventional subjects in rewrite", () => {
    const c = { ...commit, subject: "feat(api): add login" };
    const r = fallbackRoast(c, persona, "B");
    expect(r.rewrite).toBe("feat(api): add login");
  });
});

describe("roaster.resolveConfigFromEnv", () => {
  it("reads env vars with defaults", () => {
    const cfg = resolveConfigFromEnv({
      ROAST_API_KEY: "sk-xxx",
      ROAST_MODEL: "gpt-test",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe("sk-xxx");
    expect(cfg.model).toBe("gpt-test");
    expect(cfg.apiBase).toBe("https://api.openai.com/v1");
  });
});

describe("roaster.roastCommit", () => {
  it("falls back when no api key", async () => {
    const r = await roastCommit(commit, persona, "C", {});
    expect(r.source).toBe("fallback");
  });

  it("uses LLM response when fetch succeeds", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"roast":"weak","rewrite":"fix: the thing"}',
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;
    const r = await roastCommit(commit, persona, "C", {
      apiKey: "sk-test",
      apiBase: "https://example.com/v1",
      model: "gpt-test",
      fetchImpl: mockFetch,
    });
    expect(r.source).toBe("llm");
    expect(r.roast).toBe("weak");
    expect(r.rewrite).toBe("fix: the thing");
  });

  it("falls back when LLM returns non-JSON", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "haha no json for you" } }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const r = await roastCommit(commit, persona, "C", {
      apiKey: "sk-test",
      fetchImpl: mockFetch,
    });
    expect(r.source).toBe("fallback");
  });

  it("falls back on non-2xx", async () => {
    const mockFetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const r = await roastCommit(commit, persona, "C", {
      apiKey: "sk-test",
      fetchImpl: mockFetch,
    });
    expect(r.source).toBe("fallback");
  });
});
