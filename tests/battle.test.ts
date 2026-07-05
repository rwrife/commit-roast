import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJudgeMessages,
  judgeBattle,
  offlineJudge,
  parseBattleFlag,
  runBattle,
  safeParseJudge,
  shouldRenderSideBySide,
  SIDE_BY_SIDE_MIN_COLS,
  type BattleEntry,
} from "../src/battle.js";
import { parsePersonaFile } from "../src/personaLoader.js";
import { RoastCache, makeCacheKey } from "../src/cache.js";
import type { Commit } from "../src/git.js";

const commit: Commit = {
  sha: "0".repeat(40),
  shortSha: "0000000",
  subject: "fix login token expiry",
  body: "",
  author: "tester",
  date: "2026-06-14T00:00:00Z",
};

const linus = parsePersonaFile(
  `---\nname: linus\nstyle: blunt\ntemperature: 0.7\n---\nYou are Linus.`,
  "linus"
);
const pm = parsePersonaFile(
  `---\nname: pm\nstyle: passive-aggressive\ntemperature: 0.8\n---\nYou are a PM.`,
  "pm"
);
const bard = parsePersonaFile(
  `---\nname: bard\nstyle: elizabethan\ntemperature: 0.9\n---\nYou are Shakespeare.`,
  "bard"
);

async function tmpCachePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commit-roast-battle-"));
  return join(dir, "roasts.json");
}

describe("battle.parseBattleFlag", () => {
  it("accepts a plain 2-persona list", () => {
    expect(parseBattleFlag("linus,pm")).toEqual(["linus", "pm"]);
  });

  it("lowercases, trims, and de-dupes while preserving order", () => {
    expect(parseBattleFlag(" Linus , PM , linus , bard ")).toEqual([
      "linus",
      "pm",
      "bard",
    ]);
  });

  it("rejects fewer than 2 personas", () => {
    expect(() => parseBattleFlag("linus")).toThrow(/2\W?4 personas/);
  });

  it("rejects more than 4 personas", () => {
    expect(() => parseBattleFlag("a,b,c,d,e")).toThrow(/2\W?4 personas/);
  });

  it("rejects illegal characters in persona names", () => {
    expect(() => parseBattleFlag("linus,../etc/passwd")).toThrow(/invalid persona name/);
  });

  it("rejects empty or whitespace-only input", () => {
    expect(() => parseBattleFlag("")).toThrow();
    expect(() => parseBattleFlag("   ")).toThrow();
  });
});

describe("battle.runBattle cache-key isolation", () => {
  let cachePath: string;
  beforeEach(async () => {
    cachePath = await tmpCachePath();
  });

  it("writes a separate cache entry per persona/commit pair", async () => {
    const cache = new RoastCache({ path: cachePath });
    // Deterministic mock: each persona returns a distinct roast so we can
    // assert both are cached with the right key.
    const mockFetch = ((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const sys = body.messages[0].content as string;
      const persona = sys.includes("You are Linus.") ? "linus" : "pm";
      const content = JSON.stringify({
        roast: `roast-from-${persona}`,
        rewrite: `fix: ${persona}-rewrite`,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }) as unknown as typeof fetch;

    const entries = await runBattle({
      commit,
      personas: [linus, pm],
      grade: "B",
      config: {
        apiKey: "sk-test",
        apiBase: "https://example.com/v1",
        model: "gpt-test",
        fetchImpl: mockFetch,
      },
      cache,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      persona: "linus",
      roast: "roast-from-linus",
      source: "llm",
    });
    expect(entries[1]).toMatchObject({
      persona: "pm",
      roast: "roast-from-pm",
      source: "llm",
    });

    // Each persona got its own cache entry (keys differ by persona).
    const linusKey = makeCacheKey({
      commitSha: commit.sha,
      persona: "linus",
      model: "gpt-test",
    });
    const pmKey = makeCacheKey({
      commitSha: commit.sha,
      persona: "pm",
      model: "gpt-test",
    });
    expect(linusKey).not.toBe(pmKey);
    const snap = cache.snapshot();
    expect(Object.keys(snap.entries)).toContain(linusKey);
    expect(Object.keys(snap.entries)).toContain(pmKey);
    expect(snap.entries[linusKey]!.roast).toBe("roast-from-linus");
    expect(snap.entries[pmKey]!.roast).toBe("roast-from-pm");
  });

  it("marks cached entries with source=cache on the second run", async () => {
    const cache = new RoastCache({ path: cachePath });
    const mockFetch = ((_url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ roast: "hot", rewrite: "fix: bug" }),
                },
              },
            ],
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch;

    const first = await runBattle({
      commit,
      personas: [linus],
      grade: "C",
      config: { apiKey: "sk-test", model: "gpt-test", fetchImpl: mockFetch },
      cache,
    });
    expect(first[0]!.source).toBe("llm");

    // Second call: fetch should not be hit because the entry is cached.
    let called = 0;
    const failingFetch = (() => {
      called += 1;
      throw new Error("cache should have satisfied this request");
    }) as unknown as typeof fetch;
    const second = await runBattle({
      commit,
      personas: [linus],
      grade: "C",
      config: { apiKey: "sk-test", model: "gpt-test", fetchImpl: failingFetch },
      cache,
    });
    expect(called).toBe(0);
    expect(second[0]!.source).toBe("cache");
  });

  it("offline=true returns fallback roasts for every persona and skips fetch", async () => {
    const cache = new RoastCache({ path: cachePath });
    const failingFetch = (() => {
      throw new Error("no fetch expected in offline mode");
    }) as unknown as typeof fetch;
    const entries = await runBattle({
      commit,
      personas: [linus, pm, bard],
      grade: "C",
      config: { apiKey: "sk-test", model: "gpt-test", fetchImpl: failingFetch },
      cache,
      offline: true,
    });
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.source).toBe("fallback");
      expect(e.roast).toBeTruthy();
    }
  });
});

describe("battle.safeParseJudge", () => {
  it("parses clean JSON", () => {
    expect(safeParseJudge('{"winner":"linus","reason":"punchier"}')).toEqual({
      winner: "linus",
      reason: "punchier",
    });
  });

  it("lowercases the winner name", () => {
    expect(safeParseJudge('{"winner":"LINUS","reason":"loud"}')?.winner).toBe("linus");
  });

  it("strips code fences", () => {
    const r = safeParseJudge('```json\n{"winner":"pm","reason":"softer"}\n```');
    expect(r?.winner).toBe("pm");
  });

  it("rejects garbage", () => {
    expect(safeParseJudge("nope")).toBeNull();
    expect(safeParseJudge("")).toBeNull();
    expect(safeParseJudge('{"winner":""}')).toBeNull();
    expect(safeParseJudge('{"winner":"pm"}')).toBeNull();
  });
});

describe("battle.offlineJudge", () => {
  it("prefers the roast that name-drops commit-subject words", () => {
    const entries: BattleEntry[] = [
      { persona: "linus", roast: "generic burn", rewrite: "x", source: "fallback" },
      {
        persona: "pm",
        roast: "your login token expiry patch is a whole vibe",
        rewrite: "x",
        source: "fallback",
      },
    ];
    const j = offlineJudge(commit, entries);
    expect(j.winner).toBe("pm");
    expect(j.source).toBe("offline");
    expect(j.reason).toMatch(/commit-specific|meatier/);
  });

  it("falls back to length tiebreak when nothing name-drops", () => {
    const entries: BattleEntry[] = [
      { persona: "linus", roast: "short.", rewrite: "x", source: "fallback" },
      {
        persona: "pm",
        roast: "this is a considerably longer roast that has more meat to it",
        rewrite: "x",
        source: "fallback",
      },
    ];
    // Commit subject is "fix login token expiry"; neither roast mentions those
    // words, so length breaks the tie.
    const j = offlineJudge(commit, entries);
    expect(j.winner).toBe("pm");
  });

  it("returns a safe result on empty input", () => {
    const j = offlineJudge(commit, []);
    expect(j.winner).toBe("");
    expect(j.source).toBe("offline");
  });
});

describe("battle.judgeBattle fallback path", () => {
  const entries: BattleEntry[] = [
    { persona: "linus", roast: "meh", rewrite: "x", source: "fallback" },
    { persona: "pm", roast: "sure", rewrite: "x", source: "fallback" },
  ];

  it("uses offlineJudge when no API key is set", async () => {
    const j = await judgeBattle({ commit, entries, config: {} });
    expect(j.source).toBe("offline");
    expect(["linus", "pm"]).toContain(j.winner);
  });

  it("falls back when the LLM returns unparseable content", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "not-json" } }] }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const j = await judgeBattle({
      commit,
      entries,
      config: { apiKey: "sk-test", model: "gpt-test", fetchImpl: mockFetch },
    });
    expect(j.source).toBe("fallback");
    expect(["linus", "pm"]).toContain(j.winner);
  });

  it("falls back when the LLM picks a persona not in the battle", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ winner: "bard", reason: "iambic" }),
              },
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const j = await judgeBattle({
      commit,
      entries, // linus + pm only
      config: { apiKey: "sk-test", fetchImpl: mockFetch },
    });
    expect(j.source).toBe("fallback");
    expect(["linus", "pm"]).toContain(j.winner);
  });

  it("uses the LLM result when the winner is valid", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ winner: "linus", reason: "sharper" }),
              },
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const j = await judgeBattle({
      commit,
      entries,
      config: { apiKey: "sk-test", fetchImpl: mockFetch },
    });
    expect(j.source).toBe("llm");
    expect(j.winner).toBe("linus");
    expect(j.reason).toBe("sharper");
  });

  it("falls back on non-2xx response", async () => {
    const mockFetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const j = await judgeBattle({
      commit,
      entries,
      config: { apiKey: "sk-test", fetchImpl: mockFetch },
    });
    expect(j.source).toBe("fallback");
  });
});

describe("battle.buildJudgeMessages", () => {
  const entries: BattleEntry[] = [
    { persona: "linus", roast: "acidic take", rewrite: "x", source: "llm" },
    { persona: "pm", roast: "soft take", rewrite: "x", source: "llm" },
  ];

  it("lists every persona in both the system and user prompts", () => {
    const msgs = buildJudgeMessages(commit, entries);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("linus, pm");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("[linus] acidic take");
    expect(msgs[1].content).toContain("[pm] soft take");
    expect(msgs[1].content).toContain(commit.subject);
  });
});

describe("battle.shouldRenderSideBySide width breakpoint", () => {
  it(`returns true when requested and cols \u2265 ${SIDE_BY_SIDE_MIN_COLS}`, () => {
    expect(shouldRenderSideBySide(true, SIDE_BY_SIDE_MIN_COLS, 2)).toBe(true);
    expect(shouldRenderSideBySide(true, SIDE_BY_SIDE_MIN_COLS + 40, 2)).toBe(true);
  });

  it("falls back to stacked when cols below breakpoint", () => {
    expect(shouldRenderSideBySide(true, SIDE_BY_SIDE_MIN_COLS - 1, 2)).toBe(false);
    expect(shouldRenderSideBySide(true, 80, 2)).toBe(false);
  });

  it("falls back when width is unknown (e.g. non-TTY stdout)", () => {
    expect(shouldRenderSideBySide(true, undefined, 2)).toBe(false);
    expect(shouldRenderSideBySide(true, 0, 2)).toBe(false);
  });

  it("returns false when the caller didn't request it", () => {
    expect(shouldRenderSideBySide(false, 200, 2)).toBe(false);
    expect(shouldRenderSideBySide(undefined, 200, 2)).toBe(false);
  });

  it("returns false when fewer than 2 personas are competing", () => {
    expect(shouldRenderSideBySide(true, 200, 1)).toBe(false);
    expect(shouldRenderSideBySide(true, 200, 0)).toBe(false);
  });
});
