/**
 * Local-model presets.
 *
 * A preset is a tiny bundle of `(apiBase, default model[, hint])` that fills in
 * sensible defaults for popular local OpenAI-compatible endpoints (ollama,
 * lmstudio, llamacpp) without forcing users to mess with `ROAST_API_BASE` /
 * `ROAST_MODEL` env vars.
 *
 * Precedence (per #28):
 *   explicit CLI flags > preset > env vars > ~/.commit-roastrc > built-in defaults
 *
 * Note: `ROAST_API_KEY` is treated as a secret and is *always* read from env
 * regardless of preset (most local servers ignore it; OpenAI requires it).
 */

export interface Preset {
  /** Stable identifier (matches `--preset <name>`). */
  name: string;
  /** OpenAI-compatible base URL (no trailing slash). */
  apiBase: string;
  /** Default model name when `--preset <name>` is used with no `:model` suffix. */
  model: string;
  /** One-line human description, shown in `presets list`. */
  description: string;
  /** Suggested command to start the server if it's not reachable. */
  startHint?: string;
}

export const BUILTIN_PRESETS: readonly Preset[] = [
  {
    name: "openai",
    apiBase: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    description: "OpenAI hosted API (requires ROAST_API_KEY).",
  },
  {
    name: "ollama",
    apiBase: "http://localhost:11434/v1",
    model: "qwen2.5-coder",
    description: "Local Ollama server (https://ollama.com).",
    startHint: "ollama serve  # then: ollama pull qwen2.5-coder",
  },
  {
    name: "lmstudio",
    apiBase: "http://localhost:1234/v1",
    model: "local-model",
    description: "Local LM Studio server (https://lmstudio.ai).",
    startHint: "Open LM Studio → Local Server → Start Server",
  },
  {
    name: "llamacpp",
    apiBase: "http://localhost:8080/v1",
    model: "local-model",
    description: "Local llama.cpp server (`llama-server`).",
    startHint: "llama-server -m /path/to/model.gguf --port 8080",
  },
];

export interface ParsedPreset {
  name: string;
  /** Optional model override pulled from `--preset name:model` syntax. */
  model?: string;
}

/**
 * Parse a `--preset` flag value. Accepts `name` or `name:model`. The model
 * portion is everything after the *first* `:` so model names containing `:`
 * (e.g. `qwen2.5-coder:7b` for ollama) survive intact.
 */
export function parsePresetFlag(raw: string): ParsedPreset {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("--preset requires a value (e.g. --preset ollama)");
  }
  const colon = trimmed.indexOf(":");
  if (colon === -1) return { name: trimmed.toLowerCase() };
  const name = trimmed.slice(0, colon).trim().toLowerCase();
  const model = trimmed.slice(colon + 1).trim();
  if (!name) throw new Error(`Invalid --preset value: "${raw}"`);
  return model ? { name, model } : { name };
}

export function findPreset(
  name: string,
  presets: readonly Preset[] = BUILTIN_PRESETS
): Preset | undefined {
  const needle = name.toLowerCase();
  return presets.find((p) => p.name === needle);
}

export function listPresets(presets: readonly Preset[] = BUILTIN_PRESETS): Preset[] {
  return [...presets];
}

export interface ResolveRoasterOptions {
  /** Result of `parsePresetFlag` (from `--preset`). */
  preset?: ParsedPreset;
  /** Explicit `--model` flag from CLI (highest priority for model). */
  cliModel?: string;
  /** Explicit `--api-base` flag from CLI (highest priority for apiBase). */
  cliApiBase?: string;
  /** Defaults coming from `~/.commit-roastrc` (after built-ins). */
  rcDefaults?: { model?: string; apiBase?: string };
  /** Process env (or test-injected). */
  env?: NodeJS.ProcessEnv;
  /** Override preset table (for tests). */
  presets?: readonly Preset[];
}

export interface ResolvedRoasterTarget {
  apiBase: string;
  model: string;
  /** The preset that was applied, if any. Useful for unreachable hints. */
  preset?: Preset;
  /** Source of the final apiBase, mostly for debugging. */
  apiBaseSource: "cli" | "preset" | "env" | "rc" | "default";
  /** Source of the final model. */
  modelSource: "cli" | "preset-suffix" | "preset" | "env" | "rc" | "default";
}

const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * Resolve the final `(apiBase, model)` per the precedence in #28.
 *
 * Precedence for *each* field independently:
 *   1. CLI flag (`--model` / `--api-base`)
 *   2. Preset (incl. `--preset name:model` suffix for model)
 *   3. Env (`ROAST_MODEL` / `ROAST_API_BASE`)
 *   4. rc file (`model` / `apiBase`)
 *   5. Built-in defaults
 *
 * Unknown preset names throw — they're almost certainly a typo.
 */
export function resolveRoasterTarget(opts: ResolveRoasterOptions): ResolvedRoasterTarget {
  const env = opts.env ?? process.env;
  const rc = opts.rcDefaults ?? {};
  let preset: Preset | undefined;
  let presetModelOverride: string | undefined;
  if (opts.preset) {
    preset = findPreset(opts.preset.name, opts.presets);
    if (!preset) {
      const known = (opts.presets ?? BUILTIN_PRESETS).map((p) => p.name).join(", ");
      throw new Error(`Unknown preset "${opts.preset.name}". Known presets: ${known}`);
    }
    presetModelOverride = opts.preset.model;
  }

  // apiBase
  let apiBase = DEFAULT_API_BASE;
  let apiBaseSource: ResolvedRoasterTarget["apiBaseSource"] = "default";
  if (rc.apiBase) {
    apiBase = rc.apiBase;
    apiBaseSource = "rc";
  }
  if (env.ROAST_API_BASE) {
    apiBase = env.ROAST_API_BASE;
    apiBaseSource = "env";
  }
  if (preset) {
    apiBase = preset.apiBase;
    apiBaseSource = "preset";
  }
  if (opts.cliApiBase) {
    apiBase = opts.cliApiBase;
    apiBaseSource = "cli";
  }

  // model
  let model = DEFAULT_MODEL;
  let modelSource: ResolvedRoasterTarget["modelSource"] = "default";
  if (rc.model) {
    model = rc.model;
    modelSource = "rc";
  }
  if (env.ROAST_MODEL) {
    model = env.ROAST_MODEL;
    modelSource = "env";
  }
  if (preset) {
    model = preset.model;
    modelSource = "preset";
  }
  if (presetModelOverride) {
    model = presetModelOverride;
    modelSource = "preset-suffix";
  }
  if (opts.cliModel) {
    model = opts.cliModel;
    modelSource = "cli";
  }

  return { apiBase, model, preset, apiBaseSource, modelSource };
}

export interface PingResult {
  ok: boolean;
  /** Short reason if not ok (e.g. "ECONNREFUSED", "HTTP 503"). */
  reason?: string;
}

/**
 * Best-effort liveness check for a preset's `apiBase`. Hits `${apiBase}/models`
 * with a short timeout. Used purely to produce a friendly hint — never blocks
 * the actual roast, which has its own fallback.
 */
export async function pingPresetTarget(
  preset: Preset,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<PingResult> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${preset.apiBase.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await f(url, { method: "GET", signal: controller.signal });
    // Some servers return 401 without a key — that still proves it's reachable.
    if (res.ok || res.status === 401 || res.status === 403) {
      return { ok: true };
    }
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    const message =
      err instanceof Error
        ? (err as NodeJS.ErrnoException).code ?? err.name ?? err.message
        : String(err);
    return { ok: false, reason: message };
  } finally {
    clearTimeout(timer);
  }
}

export function formatUnreachableHint(preset: Preset, reason?: string): string {
  const lines = [
    `commit-roast: preset "${preset.name}" target ${preset.apiBase} is not reachable${
      reason ? ` (${reason})` : ""
    }.`,
  ];
  if (preset.startHint) {
    lines.push(`Try: ${preset.startHint}`);
  }
  lines.push("(Continuing with offline fallback roasts.)");
  return lines.join("\n");
}

export function renderPresetsList(presets: readonly Preset[] = BUILTIN_PRESETS): string {
  const rows = presets.map((p) => ({
    name: p.name,
    apiBase: p.apiBase,
    model: p.model,
    description: p.description,
  }));
  const nameW = Math.max(...rows.map((r) => r.name.length), 4);
  const baseW = Math.max(...rows.map((r) => r.apiBase.length), 7);
  const modelW = Math.max(...rows.map((r) => r.model.length), 5);
  const header =
    `${"NAME".padEnd(nameW)}  ${"BASE URL".padEnd(baseW)}  ${"MODEL".padEnd(modelW)}  DESCRIPTION`;
  const body = rows.map(
    (r) =>
      `${r.name.padEnd(nameW)}  ${r.apiBase.padEnd(baseW)}  ${r.model.padEnd(modelW)}  ${r.description}`
  );
  return [header, ...body].join("\n");
}
