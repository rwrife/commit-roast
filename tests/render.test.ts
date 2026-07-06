import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, renderJson, renderPretty, shouldDisableColor } from "../src/render.js";
import type { RoastedCommit } from "../src/bin.js";
import { VERSION } from "../src/version.js";

const sampleItems: RoastedCommit[] = [
  {
    commit: {
      sha: "abcdef1234567890",
      shortSha: "abcdef1",
      subject: "fix: stop the bleeding",
      author: "Ada",
      date: "2026-06-14T00:00:00Z",
    },
    grade: { grade: "B", score: 80, reasons: ["could be more specific"] },
    roast: { roast: "Adequate.", rewrite: "fix(io): close socket on error", source: "offline" },
  },
  {
    commit: {
      sha: "1234567890abcdef",
      shortSha: "1234567",
      subject: "wip",
      author: "Ada",
      date: "2026-06-14T01:00:00Z",
    },
    grade: { grade: "F", score: 10, reasons: ["too short", "no type prefix"] },
    roast: { roast: "Try harder.", rewrite: "feat: add experimental thing", source: "llm" },
  },
];

describe("render", () => {
  const origNoColor = process.env.NO_COLOR;
  beforeEach(() => {
    delete process.env.NO_COLOR;
  });
  afterEach(() => {
    if (origNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = origNoColor;
  });

  it("renderJson emits a stable shape", () => {
    const out = renderJson(sampleItems, "linus");
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe(VERSION);
    expect(parsed.persona).toBe("linus");
    expect(parsed.commits).toHaveLength(2);
    expect(parsed.commits[0]).toMatchObject({
      sha: "abcdef1234567890",
      shortSha: "abcdef1",
      subject: "fix: stop the bleeding",
      grade: "B",
      score: 80,
      source: "offline",
    });
    expect(parsed.commits[1].source).toBe("llm");
  });

  it("renderPretty includes the persona emoji and grade letters", () => {
    const out = renderPretty(sampleItems, { persona: "linus", color: false });
    expect(out).toContain("🐧");
    expect(out).toContain("commit-roast");
    expect(out).toContain("linus");
    expect(out).toContain(" B ");
    expect(out).toContain(" F ");
    expect(out).toContain("abcdef1");
    expect(out).toContain("fix: stop the bleeding");
    expect(out).toContain("rewrite");
  });

  it("renderPretty strips ANSI when --no-color is passed", () => {
    const out = renderPretty(sampleItems, { persona: "linus", color: false });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("renderPretty notes offline mode only when no LLM was used", () => {
    const allOffline = sampleItems.map((i) => ({ ...i, roast: { ...i.roast, source: "offline" as const } }));
    const out = renderPretty(allOffline, { persona: "linus", color: false });
    expect(out).toContain("offline mode");
    const withLlm = renderPretty(sampleItems, { persona: "linus", color: false });
    expect(withLlm).not.toContain("offline mode");
  });

  it("render dispatches based on mode", () => {
    const json = render(sampleItems, { persona: "bard", mode: "json" });
    expect(() => JSON.parse(json)).not.toThrow();
    const pretty = render(sampleItems, { persona: "bard", mode: "pretty", color: false });
    expect(pretty).toContain("🎭");
  });

  it("shouldDisableColor honors --no-color and NO_COLOR env", () => {
    expect(shouldDisableColor(false)).toBe(true);
    expect(shouldDisableColor(true)).toBe(false);
    expect(shouldDisableColor(undefined)).toBe(false);
    process.env.NO_COLOR = "1";
    expect(shouldDisableColor(true)).toBe(true);
    expect(shouldDisableColor(undefined)).toBe(true);
  });

  it("renderQuiet emits one terse line per commit and no roast body", () => {
    const out = render(sampleItems, { persona: "linus", color: false, quiet: true });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(out).toContain("abcdef1");
    expect(out).toContain("1234567");
    expect(out).toContain("fix: stop the bleeding");
    expect(out).not.toContain("roast");
    expect(out).not.toContain("rewrite");
  });

  it("renderQuiet marks commits below threshold as FAIL", () => {
    const out = render(sampleItems, {
      persona: "linus",
      color: false,
      quiet: true,
      threshold: "C",
    });
    // B passes, F fails.
    const [bLine, fLine] = out.split("\n");
    expect(bLine).not.toContain("FAIL");
    expect(fLine).toContain("FAIL");
  });

  it("renderJson adds failedThreshold when threshold is set", () => {
    const out = renderJson(sampleItems, { persona: "linus", threshold: "C" });
    const parsed = JSON.parse(out);
    expect(parsed.commits[0].failedThreshold).toBe(false); // B vs C
    expect(parsed.commits[1].failedThreshold).toBe(true);  // F vs C
  });

  it("renderJson omits failedThreshold when no threshold given", () => {
    const out = renderJson(sampleItems, { persona: "linus" });
    const parsed = JSON.parse(out);
    expect(parsed.commits[0].failedThreshold).toBeUndefined();
  });
});

import { renderJson as renderJsonDiff } from "../src/render.js";

describe("render --diff JSON fields", () => {
  it("emits diffIncluded=false and diffBytes=0 when no diff was attached", () => {
    const out = renderJsonDiff(sampleItems, { persona: "linus" });
    const parsed = JSON.parse(out);
    expect(parsed.commits[0].diffIncluded).toBe(false);
    expect(parsed.commits[0].diffBytes).toBe(0);
  });

  it("emits diffIncluded=true and diffBytes when diff was attached", () => {
    const withDiff = [
      {
        ...sampleItems[0],
        diff: { diff: "diff --git a/x b/x\n+1\n", bytes: 22, truncated: false, skipped: [] },
      },
    ];
    const out = renderJsonDiff(withDiff, { persona: "linus" });
    const parsed = JSON.parse(out);
    expect(parsed.commits[0].diffIncluded).toBe(true);
    expect(parsed.commits[0].diffBytes).toBe(22);
  });
});

describe("render battle mode", () => {
  it("renderJson adds battle and judge keys only when populated", () => {
    const withBattle = [
      {
        ...sampleItems[0],
        battle: [
          { persona: "linus", roast: "blunt", rewrite: "fix: x", source: "llm" as const },
          { persona: "pm", roast: "soft", rewrite: "fix: x", source: "llm" as const },
        ],
        judge: { winner: "linus", reason: "punchier", source: "llm" as const },
      },
      sampleItems[1], // no battle here — key should NOT appear
    ];
    const out = renderJson(withBattle, { persona: "linus" });
    const parsed = JSON.parse(out);
    expect(parsed.commits[0].battle).toHaveLength(2);
    expect(parsed.commits[0].battle[0].persona).toBe("linus");
    expect(parsed.commits[0].judge).toEqual({
      winner: "linus",
      reason: "punchier",
      source: "llm",
    });
    // Second commit has no battle — fields must be absent to keep the
    // non-battle JSON schema identical for downstream consumers.
    expect(parsed.commits[1].battle).toBeUndefined();
    expect(parsed.commits[1].judge).toBeUndefined();
  });

  it("renderPretty shows a battle block per persona and a judge line when present", () => {
    const withBattle = [
      {
        ...sampleItems[0],
        battle: [
          { persona: "linus", roast: "blunt take", rewrite: "fix: x", source: "llm" as const },
          { persona: "pm", roast: "soft take", rewrite: "fix: x", source: "llm" as const },
        ],
        judge: { winner: "linus", reason: "sharper", source: "offline" as const },
      },
    ];
    const out = renderPretty(withBattle, {
      persona: "linus",
      color: false,
      battle: true,
    });
    expect(out).toContain("battle");
    expect(out).toContain("linus");
    expect(out).toContain("pm");
    expect(out).toContain("blunt take");
    expect(out).toContain("soft take");
    expect(out).toContain("judge");
    expect(out).toContain("🏆");
    expect(out).toContain("sharper");
    expect(out).toContain("(offline)");
    // Non-battle single-persona roast/rewrite lines are suppressed in
    // battle mode so we don't render the same commit twice.
    const roastLineHits = out.split("\n").filter((l) => /^\s+roast\s/.test(l));
    expect(roastLineHits.length).toBe(0);
  });
});
