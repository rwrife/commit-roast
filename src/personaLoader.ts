import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Persona {
  name: string;
  style: string;
  temperature: number;
  prompt: string; // markdown body, used as system prompt
}

export interface LoadPersonaOptions {
  /**
   * Directory to look in for the persona file. When set, overrides the
   * default lookup (user personas dir + built-in dir).
   */
  dir?: string;
  /** Override $HOME for user-personas lookup (tests). */
  home?: string;
  /** Override the user-personas directory directly (tests). */
  userDir?: string;
}

function defaultPersonasDir(): string {
  // bin runs from dist/, src runs from src/. Try a few locations.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "personas");
}

function defaultUserPersonasDir(home: string = homedir()): string {
  return join(home, ".commit-roast", "personas");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a markdown file with simple `---` YAML-ish frontmatter.
 * We only need name/style/temperature, so we do a tiny parser instead
 * of pulling in a yaml dep.
 */
export function parsePersonaFile(content: string, fallbackName: string): Persona {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return {
      name: fallbackName,
      style: "",
      temperature: 0.8,
      prompt: content.trim(),
    };
  }
  const [, fm, body] = m;
  const meta: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = val;
  }
  const tempRaw = meta.temperature ?? "0.8";
  const temperature = Number.isFinite(Number(tempRaw)) ? Number(tempRaw) : 0.8;
  return {
    name: (meta.name || fallbackName).toLowerCase(),
    style: meta.style ?? "",
    temperature,
    prompt: (body ?? "").trim(),
  };
}

export async function loadPersona(
  name: string,
  opts: LoadPersonaOptions = {}
): Promise<Persona> {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!safe) throw new Error(`Invalid persona name: ${name}`);

  // Explicit dir override short-circuits the user/built-in lookup.
  if (opts.dir) {
    const path = join(opts.dir, `${safe}.md`);
    const content = await readFile(path, "utf8");
    return parsePersonaFile(content, safe);
  }

  const userDir = opts.userDir ?? defaultUserPersonasDir(opts.home);
  const userPath = join(userDir, `${safe}.md`);
  if (await fileExists(userPath)) {
    const content = await readFile(userPath, "utf8");
    return parsePersonaFile(content, safe);
  }

  const builtinPath = join(defaultPersonasDir(), `${safe}.md`);
  const content = await readFile(builtinPath, "utf8");
  return parsePersonaFile(content, safe);
}

export async function listPersonas(opts: LoadPersonaOptions = {}): Promise<string[]> {
  if (opts.dir) {
    return readMdNames(opts.dir);
  }
  const userDir = opts.userDir ?? defaultUserPersonasDir(opts.home);
  const builtin = await readMdNames(defaultPersonasDir());
  const user = await readMdNames(userDir);
  return [...new Set([...builtin, ...user])].sort();
}

async function readMdNames(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => f.replace(/\.md$/i, ""))
      .sort();
  } catch {
    return [];
  }
}
