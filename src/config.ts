import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * User configuration loaded from `~/.commit-roastrc`.
 *
 * Resolution order (lowest -> highest priority):
 *   1. Built-in defaults (see `DEFAULT_CONFIG`)
 *   2. `~/.commit-roastrc` (JSON)
 *   3. CLI flags
 *   4. Environment variables (always win for secrets)
 */
export interface UserConfig {
  /** Default persona name (e.g. "linus", "pm"). */
  persona?: string;
  /** Default commit count to roast. */
  count?: number;
  /** Default model name passed to the LLM endpoint. */
  model?: string;
  /** Default OpenAI-compatible base URL. */
  apiBase?: string;
  /** Maximum cache entries before LRU eviction (default 1000). */
  cacheMaxEntries?: number;
  /** Disable the roast cache entirely. */
  cacheDisabled?: boolean;
}

export const DEFAULT_CONFIG: Required<Pick<UserConfig, "persona" | "count">> = {
  persona: "linus",
  count: 5,
};

export interface LoadConfigOptions {
  /** Override the path to the rc file (mostly for tests). */
  path?: string;
  /** Override `$HOME` lookup (mostly for tests). */
  home?: string;
}

export function defaultConfigPath(home: string = homedir()): string {
  return join(home, ".commit-roastrc");
}

/**
 * Read `~/.commit-roastrc` if present. Missing file -> `{}`.
 * Malformed JSON -> `{}` plus a warning on stderr; we don't want a bad
 * rc file to brick the CLI.
 */
export async function loadUserConfig(opts: LoadConfigOptions = {}): Promise<UserConfig> {
  const path = opts.path ?? defaultConfigPath(opts.home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    // Permission errors etc. — surface but don't crash.
    process.stderr.write(
      `commit-roast: could not read ${path}: ${err instanceof Error ? err.message : err}\n`
    );
    return {};
  }
  return parseUserConfig(raw, path);
}

export function parseUserConfig(raw: string, sourceLabel = "<rc>"): UserConfig {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (err) {
    process.stderr.write(
      `commit-roast: ignoring ${sourceLabel} (invalid JSON: ${err instanceof Error ? err.message : err})\n`
    );
    return {};
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const record = obj as Record<string, unknown>;
  const out: UserConfig = {};
  if (typeof record.persona === "string" && record.persona.trim()) {
    out.persona = record.persona.trim();
  }
  if (typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0) {
    out.count = Math.floor(record.count);
  } else if (typeof record.count === "string" && /^\d+$/.test(record.count)) {
    out.count = Number(record.count);
  }
  if (typeof record.model === "string" && record.model.trim()) {
    out.model = record.model.trim();
  }
  if (typeof record.apiBase === "string" && record.apiBase.trim()) {
    out.apiBase = record.apiBase.trim();
  }
  if (
    typeof record.cacheMaxEntries === "number" &&
    Number.isFinite(record.cacheMaxEntries) &&
    record.cacheMaxEntries > 0
  ) {
    out.cacheMaxEntries = Math.floor(record.cacheMaxEntries);
  }
  if (typeof record.cacheDisabled === "boolean") {
    out.cacheDisabled = record.cacheDisabled;
  }
  return out;
}

export interface ResolvedDefaults {
  persona: string;
  count: number;
  model?: string;
  apiBase?: string;
  cacheMaxEntries?: number;
  cacheDisabled?: boolean;
}

/**
 * Merge built-in defaults with user config. CLI flags merge on top of
 * this in `bin.ts`; env-only secrets are handled in `roaster.ts`.
 */
export function resolveDefaults(user: UserConfig = {}): ResolvedDefaults {
  return {
    persona: user.persona ?? DEFAULT_CONFIG.persona,
    count: user.count ?? DEFAULT_CONFIG.count,
    model: user.model,
    apiBase: user.apiBase,
    cacheMaxEntries: user.cacheMaxEntries,
    cacheDisabled: user.cacheDisabled,
  };
}
