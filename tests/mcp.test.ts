import { describe, expect, it, vi } from "vitest";
import {
  buildMcpServer,
  handleGrade,
  handleRewrite,
  handleRoast,
} from "../src/mcp.js";
import type { Persona } from "../src/personaLoader.js";
import type { RewritePlan } from "../src/rewrite.js";

const TEST_PERSONA: Persona = {
  name: "linus",
  style: "harsh",
  temperature: 0.7,
  prompt: "Be Linus.",
};

const fakeResolvePersona = async () => TEST_PERSONA;

describe("handleGrade", () => {
  it("grades a good Conventional Commits subject as A or B", () => {
    const result = handleGrade({ subject: "feat(parser): support nested arrays" });
    expect(["A", "B"]).toContain(result.grade);
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it("fails an empty subject", () => {
    const result = handleGrade({ subject: "" });
    expect(result.grade).toBe("F");
  });

  it("throws on missing subject", () => {
    expect(() => handleGrade({} as any)).toThrow(/Missing required field: subject/);
  });

  it("rejects non-string subject", () => {
    expect(() => handleGrade({ subject: 42 } as any)).toThrow(/must be a string/);
  });
});

describe("handleRoast", () => {
  it("returns grade + roast for a subject using offline fallback", async () => {
    const result = await handleRoast(
      { subject: "wip" },
      {
        resolvePersona: fakeResolvePersona,
        roasterConfig: {}, // no apiKey -> falls back to canned roast
        env: {},
      }
    );
    expect(result.persona).toBe("linus");
    expect(result.grade.grade).toBe("F");
    expect(result.roast.source).toBe("fallback");
    expect(typeof result.roast.roast).toBe("string");
    expect(typeof result.roast.rewrite).toBe("string");
  });

  it("uses the supplied persona name (lowercased)", async () => {
    const spy = vi.fn(fakeResolvePersona);
    await handleRoast(
      { subject: "fix: typo", persona: "BARD" },
      { resolvePersona: spy, roasterConfig: {}, env: {} }
    );
    expect(spy).toHaveBeenCalledWith("bard");
  });

  it("throws when subject is missing", async () => {
    await expect(
      handleRoast({} as any, { resolvePersona: fakeResolvePersona })
    ).rejects.toThrow(/Missing required field: subject/);
  });
});

describe("handleRewrite", () => {
  it("delegates to the injected buildRewrite", async () => {
    const plan: RewritePlan = {
      mode: "amend",
      sha: "deadbeefdeadbeef",
      shortSha: "deadbee",
      originalSubject: "wip",
      rewrite: "chore: wip",
      roast: "canned",
      command: "git commit --amend -m 'chore: wip'",
    };
    const buildRewrite = vi.fn(async () => plan);
    const result = await handleRewrite(
      { sha: "HEAD", force: true },
      { buildRewrite, env: {} }
    );
    expect(result).toBe(plan);
    expect(buildRewrite).toHaveBeenCalledWith({
      sha: "HEAD",
      force: true,
      env: {},
    });
  });

  it("throws when sha is missing", async () => {
    await expect(
      handleRewrite({} as any, { buildRewrite: vi.fn() })
    ).rejects.toThrow(/Missing required field: sha/);
  });
});

describe("buildMcpServer", () => {
  it("constructs a server without throwing", () => {
    const server = buildMcpServer();
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });
});
