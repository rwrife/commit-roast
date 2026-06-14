import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Persona {
  name: string;
  style: string;
  temperature: number;
  prompt: string; // markdown body, used as system prompt
}

export interface LoadPersonaOptions {
  dir?: string;
}

function defaultPersonasDir(): string {
  // bin runs from dist/, src runs from src/. Try a few locations.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "personas");
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
  const dir = opts.dir ?? defaultPersonasDir();
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!safe) throw new Error(`Invalid persona name: ${name}`);
  const path = join(dir, `${safe}.md`);
  const content = await readFile(path, "utf8");
  return parsePersonaFile(content, safe);
}

export async function listPersonas(opts: LoadPersonaOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? defaultPersonasDir();
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}
