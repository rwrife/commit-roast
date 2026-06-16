import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  defaultConfigPath,
  loadUserConfig,
  parseUserConfig,
  resolveDefaults,
} from "../src/config.js";
import { resolveConfigFromEnv } from "../src/roaster.js";

describe("config.parseUserConfig", () => {
  it("parses valid JSON", () => {
    const cfg = parseUserConfig(
      `{"persona":"bard","count":3,"model":"qwen2.5-coder","apiBase":"http://localhost:11434/v1"}`
    );
    expect(cfg).toEqual({
      persona: "bard",
      count: 3,
      model: "qwen2.5-coder",
      apiBase: "http://localhost:11434/v1",
    });
  });

  it("ignores empty / non-object payloads", () => {
    expect(parseUserConfig("")).toEqual({});
    expect(parseUserConfig("[]")).toEqual({});
    expect(parseUserConfig("null")).toEqual({});
  });

  it("coerces stringy counts and rejects garbage", () => {
    expect(parseUserConfig(`{"count":"7"}`)).toEqual({ count: 7 });
    expect(parseUserConfig(`{"count":"nope"}`)).toEqual({});
    expect(parseUserConfig(`{"count":-2}`)).toEqual({});
  });

  it("tolerates malformed JSON without throwing", () => {
    expect(parseUserConfig("{ not json")).toEqual({});
  });
});

describe("config.resolveDefaults", () => {
  it("falls back to built-in defaults when no user config", () => {
    expect(resolveDefaults()).toEqual({
      persona: DEFAULT_CONFIG.persona,
      count: DEFAULT_CONFIG.count,
      model: undefined,
      apiBase: undefined,
    });
  });

  it("user values override defaults", () => {
    expect(resolveDefaults({ persona: "pm", count: 9 })).toMatchObject({
      persona: "pm",
      count: 9,
    });
  });
});

describe("config.loadUserConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "commit-roast-cfg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns {} when file missing", async () => {
    expect(await loadUserConfig({ home: dir })).toEqual({});
  });

  it("reads ~/.commit-roastrc when present", async () => {
    await writeFile(defaultConfigPath(dir), `{"persona":"teacher","count":2}`);
    const cfg = await loadUserConfig({ home: dir });
    expect(cfg).toEqual({ persona: "teacher", count: 2 });
  });
});

describe("roaster.resolveConfigFromEnv (rc fallbacks)", () => {
  it("env vars override rc fallbacks", () => {
    const cfg = resolveConfigFromEnv(
      { ROAST_API_BASE: "https://env.example/v1", ROAST_MODEL: "env-model" },
      { apiBase: "https://rc.example/v1", model: "rc-model" }
    );
    expect(cfg.apiBase).toBe("https://env.example/v1");
    expect(cfg.model).toBe("env-model");
  });

  it("rc fallbacks apply when env is silent", () => {
    const cfg = resolveConfigFromEnv(
      {},
      { apiBase: "https://rc.example/v1", model: "rc-model" }
    );
    expect(cfg.apiBase).toBe("https://rc.example/v1");
    expect(cfg.model).toBe("rc-model");
  });

  it("built-in defaults remain when neither env nor rc supplied", () => {
    const cfg = resolveConfigFromEnv({});
    expect(cfg.apiBase).toBe("https://api.openai.com/v1");
    expect(cfg.model).toBe("gpt-4o-mini");
  });
});
