import { describe, it, expect } from "vitest";
import {
  BUILTIN_PRESETS,
  findPreset,
  formatUnreachableHint,
  parsePresetFlag,
  pingPresetTarget,
  renderPresetsList,
  resolveRoasterTarget,
  type Preset,
} from "../src/presets.js";

describe("presets.parsePresetFlag", () => {
  it("parses bare name", () => {
    expect(parsePresetFlag("ollama")).toEqual({ name: "ollama" });
  });
  it("lower-cases the name", () => {
    expect(parsePresetFlag("Ollama")).toEqual({ name: "ollama" });
  });
  it("parses name:model", () => {
    expect(parsePresetFlag("ollama:qwen2.5-coder")).toEqual({
      name: "ollama",
      model: "qwen2.5-coder",
    });
  });
  it("keeps colons inside the model portion (e.g. ollama tag syntax)", () => {
    expect(parsePresetFlag("ollama:qwen2.5-coder:7b")).toEqual({
      name: "ollama",
      model: "qwen2.5-coder:7b",
    });
  });
  it("ignores empty model suffix", () => {
    expect(parsePresetFlag("ollama:")).toEqual({ name: "ollama" });
  });
  it("rejects empty input", () => {
    expect(() => parsePresetFlag("  ")).toThrow(/requires a value/);
  });
  it("rejects empty name with model", () => {
    expect(() => parsePresetFlag(":foo")).toThrow(/Invalid --preset/);
  });
});

describe("presets.findPreset / BUILTIN_PRESETS", () => {
  it("includes the documented presets", () => {
    const names = BUILTIN_PRESETS.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["ollama", "lmstudio", "llamacpp", "openai"]));
  });
  it("findPreset is case-insensitive", () => {
    expect(findPreset("OLLAMA")?.name).toBe("ollama");
  });
  it("findPreset returns undefined for unknown", () => {
    expect(findPreset("nope")).toBeUndefined();
  });
});

describe("presets.resolveRoasterTarget precedence", () => {
  const testPresets: Preset[] = [
    {
      name: "ollama",
      apiBase: "http://localhost:11434/v1",
      model: "qwen2.5-coder",
      description: "test",
    },
  ];

  it("falls through to built-in defaults with nothing supplied", () => {
    const r = resolveRoasterTarget({ env: {}, presets: testPresets });
    expect(r.apiBase).toBe("https://api.openai.com/v1");
    expect(r.model).toBe("gpt-4o-mini");
    expect(r.apiBaseSource).toBe("default");
    expect(r.modelSource).toBe("default");
  });

  it("rc overrides defaults", () => {
    const r = resolveRoasterTarget({
      env: {},
      rcDefaults: { model: "rc-model", apiBase: "http://rc/v1" },
      presets: testPresets,
    });
    expect(r.apiBase).toBe("http://rc/v1");
    expect(r.model).toBe("rc-model");
    expect(r.apiBaseSource).toBe("rc");
    expect(r.modelSource).toBe("rc");
  });

  it("env overrides rc", () => {
    const r = resolveRoasterTarget({
      env: { ROAST_API_BASE: "http://env/v1", ROAST_MODEL: "env-model" },
      rcDefaults: { model: "rc-model", apiBase: "http://rc/v1" },
      presets: testPresets,
    });
    expect(r.apiBase).toBe("http://env/v1");
    expect(r.model).toBe("env-model");
    expect(r.apiBaseSource).toBe("env");
    expect(r.modelSource).toBe("env");
  });

  it("preset overrides env", () => {
    const r = resolveRoasterTarget({
      env: { ROAST_API_BASE: "http://env/v1", ROAST_MODEL: "env-model" },
      preset: { name: "ollama" },
      presets: testPresets,
    });
    expect(r.apiBase).toBe("http://localhost:11434/v1");
    expect(r.model).toBe("qwen2.5-coder");
    expect(r.apiBaseSource).toBe("preset");
    expect(r.modelSource).toBe("preset");
  });

  it("preset :model suffix wins over preset's default model", () => {
    const r = resolveRoasterTarget({
      env: {},
      preset: { name: "ollama", model: "llama3:8b" },
      presets: testPresets,
    });
    expect(r.model).toBe("llama3:8b");
    expect(r.modelSource).toBe("preset-suffix");
  });

  it("CLI flags trump everything", () => {
    const r = resolveRoasterTarget({
      env: { ROAST_API_BASE: "http://env/v1", ROAST_MODEL: "env-model" },
      preset: { name: "ollama", model: "llama3:8b" },
      cliModel: "cli-model",
      cliApiBase: "http://cli/v1",
      presets: testPresets,
    });
    expect(r.apiBase).toBe("http://cli/v1");
    expect(r.model).toBe("cli-model");
    expect(r.apiBaseSource).toBe("cli");
    expect(r.modelSource).toBe("cli");
  });

  it("throws on unknown preset name", () => {
    expect(() =>
      resolveRoasterTarget({ env: {}, preset: { name: "bogus" }, presets: testPresets })
    ).toThrow(/Unknown preset/);
  });
});

describe("presets.pingPresetTarget", () => {
  const p: Preset = {
    name: "ollama",
    apiBase: "http://localhost:11434/v1",
    model: "qwen2.5-coder",
    description: "test",
  };

  it("returns ok on 200", async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200 }) as unknown as Response) as typeof fetch;
    const r = await pingPresetTarget(p, { fetchImpl });
    expect(r.ok).toBe(true);
  });

  it("treats 401/403 as reachable (server is up, just unauthorized)", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 401 }) as unknown as Response) as typeof fetch;
    const r = await pingPresetTarget(p, { fetchImpl });
    expect(r.ok).toBe(true);
  });

  it("returns reason on non-ok HTTP", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503 }) as unknown as Response) as typeof fetch;
    const r = await pingPresetTarget(p, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("HTTP 503");
  });

  it("returns reason on fetch throw", async () => {
    const fetchImpl = (async () => {
      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      throw err;
    }) as typeof fetch;
    const r = await pingPresetTarget(p, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ECONNREFUSED");
  });
});

describe("presets.formatUnreachableHint / renderPresetsList", () => {
  it("includes the preset's start hint when present", () => {
    const out = formatUnreachableHint(
      {
        name: "ollama",
        apiBase: "http://localhost:11434/v1",
        model: "qwen2.5-coder",
        description: "x",
        startHint: "ollama serve",
      },
      "ECONNREFUSED"
    );
    expect(out).toMatch(/not reachable/);
    expect(out).toMatch(/ECONNREFUSED/);
    expect(out).toMatch(/ollama serve/);
  });

  it("renderPresetsList shows all built-ins with header", () => {
    const out = renderPresetsList();
    expect(out).toMatch(/NAME/);
    expect(out).toMatch(/ollama/);
    expect(out).toMatch(/lmstudio/);
    expect(out).toMatch(/llamacpp/);
    expect(out).toMatch(/openai/);
  });
});
