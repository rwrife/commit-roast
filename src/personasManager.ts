import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parsePersonaFile, type Persona } from "./personaLoader.js";

/**
 * Persona management (issue #27): install/list/remove community personas
 * from GitHub, raw URLs, or local files. Installed personas live in
 * `~/.commit-roast/personas/` and take precedence over built-ins.
 */

export type PersonaSourceKind = "gh" | "gh-dir" | "http" | "file";

export interface ParsedSource {
  kind: PersonaSourceKind;
  /** Resolved URL for `gh:` (single-file) and `http(s)://` sources. */
  url?: string;
  /** Resolved absolute path for local file sources. */
  filePath?: string;
  /** Suggested filename (basename without extension) for display/install. */
  suggestedName: string;
  /** Original source string as the user passed it. */
  raw: string;
  /** For `gh` / `gh-dir`: owner. */
  owner?: string;
  /** For `gh` / `gh-dir`: repo. */
  repo?: string;
  /** For `gh` / `gh-dir`: resolved git ref (branch, tag, or SHA). Defaults to "HEAD". */
  ref?: string;
  /**
   * For `gh-dir`: directory path inside the repo to enumerate.
   * Defaults to `personas` when the caller did not specify one
   * (i.e. bare `gh:owner/repo`).
   */
  dirPath?: string;
}

export interface PersonaEntry {
  name: string;
  source: "builtin" | "user";
  path: string;
}

export interface ManagerOptions {
  /** Override $HOME (tests). */
  home?: string;
  /** Override the built-in personas directory (tests). */
  builtinDir?: string;
  /** Override the user personas directory (tests). */
  userDir?: string;
  /** Override fetch implementation (tests). */
  fetchImpl?: typeof fetch;
}

/** Default location for user-installed personas. */
export function userPersonasDir(home: string = homedir()): string {
  return join(home, ".commit-roast", "personas");
}

/**
 * Parse a persona source spec. Supported forms:
 *   - `gh:owner/repo/path/to/file.md`          single file, default branch
 *   - `gh:owner/repo@ref/path/to/file.md`      single file, pinned ref
 *   - `gh:owner/repo`                          every `personas/*.md` in the repo (default branch)
 *   - `gh:owner/repo@ref`                      every `personas/*.md` at the given ref
 *   - `https://...` or `http://...`            raw URL (single file)
 *   - `./relative.md`, `../x.md`, or absolute  local file
 *
 * `opts.ref` overrides any `@ref` embedded in `gh:` sources; use it to wire
 * up a top-level `--ref` CLI flag without asking callers to string-splice.
 */
export function parseSource(source: string, opts: { ref?: string } = {}): ParsedSource {
  if (!source || typeof source !== "string") {
    throw new Error("Persona source is required.");
  }
  const raw = source.trim();

  if (raw.startsWith("gh:")) {
    const rest = raw.slice(3);
    // Full form with a path: owner/repo[@ref]/path/to/file.md
    const fileMatch = rest.match(/^([^/]+)\/([^/@]+)(?:@([^/]+))?\/(.+)$/);
    if (fileMatch) {
      const [, owner, repo, embeddedRef, path] = fileMatch;
      const ref = opts.ref ?? embeddedRef ?? "HEAD";
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
      return {
        kind: "gh",
        url,
        owner,
        repo,
        ref,
        suggestedName: stripExt(basename(path)),
        raw,
      };
    }
    // Bare form (marketplace bulk install): owner/repo[@ref]
    const dirMatch = rest.match(/^([^/@]+)\/([^/@]+)(?:@([^/]+))?$/);
    if (dirMatch) {
      const [, owner, repo, embeddedRef] = dirMatch;
      const ref = opts.ref ?? embeddedRef ?? "HEAD";
      return {
        kind: "gh-dir",
        owner,
        repo,
        ref,
        dirPath: "personas",
        suggestedName: repo,
        raw,
      };
    }
    throw new Error(
      `Invalid gh: source "${raw}". Expected gh:owner/repo[@ref] or gh:owner/repo[@ref]/path/to/file.md`
    );
  }

  if (/^https?:\/\//i.test(raw)) {
    let pathPart = "";
    try {
      pathPart = new URL(raw).pathname;
    } catch {
      throw new Error(`Invalid URL: ${raw}`);
    }
    return {
      kind: "http",
      url: raw,
      suggestedName: stripExt(basename(pathPart) || "persona"),
      raw,
    };
  }

  // Local file (./, ../, /abs, or bare relative).
  const filePath = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  return {
    kind: "file",
    filePath,
    suggestedName: stripExt(basename(filePath)),
    raw,
  };
}

function stripExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

/** Fetch the content for a parsed source. Returns markdown text. */
export async function fetchSourceContent(
  parsed: ParsedSource,
  opts: ManagerOptions = {}
): Promise<string> {
  if (parsed.kind === "file") {
    if (!parsed.filePath) throw new Error("Local source missing path.");
    return readFile(parsed.filePath, "utf8");
  }
  if (parsed.kind === "gh-dir") {
    throw new Error(
      "gh:owner/repo sources install multiple files; use addPersonasFromRepo instead of fetchSourceContent."
    );
  }
  if (!parsed.url) throw new Error("Remote source missing URL.");
  const f = opts.fetchImpl ?? fetch;
  const res = await f(parsed.url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch persona from ${parsed.url}: HTTP ${res.status} ${res.statusText}`
    );
  }
  return await res.text();
}

/**
 * Validate persona markdown. Requires frontmatter with at minimum a name and
 * style; temperature must parse as a finite number if present. Returns the
 * parsed persona on success; throws on failure.
 */
export function validatePersonaContent(content: string, fallbackName: string): Persona {
  if (!content || !content.trim()) {
    throw new Error("Persona file is empty.");
  }
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) {
    throw new Error("Persona is missing YAML frontmatter (--- ... ---).");
  }
  const fm = fmMatch[1];
  const meta: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = val;
  }
  if (!meta.name) throw new Error("Persona frontmatter is missing required field: name.");
  if (!meta.style) throw new Error("Persona frontmatter is missing required field: style.");
  if (meta.temperature !== undefined) {
    const t = Number(meta.temperature);
    if (!Number.isFinite(t)) {
      throw new Error(`Persona temperature is not a number: ${meta.temperature}`);
    }
  }
  const persona = parsePersonaFile(content, fallbackName);
  const safe = persona.name.replace(/[^a-z0-9_-]/g, "");
  if (!safe) {
    throw new Error(`Persona name contains no valid characters: ${persona.name}`);
  }
  return { ...persona, name: safe };
}

export interface AddResult {
  name: string;
  path: string;
  source: ParsedSource;
}

export interface AddPersonaOptions extends ManagerOptions {
  overwrite?: boolean;
  /** Overrides any `@ref` in gh: sources; forwarded to parseSource. */
  ref?: string;
}

/** Add a persona from a single-file source. Returns the installed path + canonical name. */
export async function addPersona(
  source: string,
  opts: AddPersonaOptions = {}
): Promise<AddResult> {
  const parsed = parseSource(source, { ref: opts.ref });
  if (parsed.kind === "gh-dir") {
    throw new Error(
      `Source "${source}" refers to a whole repo; use addPersonasFromRepo (or \`personas add gh:owner/repo\` at the CLI).`
    );
  }
  const content = await fetchSourceContent(parsed, opts);
  const persona = validatePersonaContent(content, parsed.suggestedName);
  const dir = opts.userDir ?? userPersonasDir(opts.home);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${persona.name}.md`);
  if (!opts.overwrite) {
    try {
      await stat(filePath);
      throw new Error(
        `Persona "${persona.name}" already installed at ${filePath}. Pass --force to overwrite.`
      );
    } catch (err: unknown) {
      // ENOENT is fine; anything else (including our throw above) bubbles up.
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "ENOENT"
      ) {
        // ok
      } else {
        throw err;
      }
    }
  }
  await writeFile(filePath, content, "utf8");
  return { name: persona.name, path: filePath, source: parsed };
}

export interface RepoInstallResult {
  installed: AddResult[];
  /** Files that were listed by the API but skipped, e.g. failed validation / already installed. */
  skipped: { path: string; reason: string }[];
}

interface GhContentEntry {
  name: string;
  path: string;
  type: string; // "file" | "dir" | ...
  download_url?: string | null;
}

/**
 * Install every `*.md` under `parsed.dirPath` (default `personas/`) from a
 * public GitHub repo referenced by a `gh:owner/repo[@ref]` source. Uses the
 * unauthenticated contents API (60 req/hr — plenty for one bulk install).
 */
export async function addPersonasFromRepo(
  source: string,
  opts: AddPersonaOptions = {}
): Promise<RepoInstallResult> {
  const parsed = parseSource(source, { ref: opts.ref });
  if (parsed.kind !== "gh-dir") {
    throw new Error(
      `Source "${source}" is a single-file source; use addPersona instead.`
    );
  }
  if (!parsed.owner || !parsed.repo) {
    throw new Error(`Malformed gh-dir source: ${source}`);
  }
  const dirPath = parsed.dirPath ?? "personas";
  const ref = parsed.ref ?? "HEAD";
  const apiUrl =
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${dirPath}` +
    `?ref=${encodeURIComponent(ref)}`;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "commit-roast",
    },
  });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `No \`${dirPath}/\` directory found in ${parsed.owner}/${parsed.repo}@${ref} (HTTP 404).`
      );
    }
    if (res.status === 403) {
      throw new Error(
        `GitHub API refused the request (HTTP 403); likely rate-limited. Try again later or use a single-file gh: source.`
      );
    }
    throw new Error(
      `Failed to list ${apiUrl}: HTTP ${res.status} ${res.statusText}`
    );
  }
  const listing = (await res.json()) as GhContentEntry[] | GhContentEntry;
  const entries = Array.isArray(listing) ? listing : [listing];
  const mdFiles = entries.filter(
    (e) => e && e.type === "file" && /\.md$/i.test(e.name) && e.download_url
  );
  if (mdFiles.length === 0) {
    throw new Error(
      `No .md persona files found under ${parsed.owner}/${parsed.repo}@${ref}/${dirPath}/.`
    );
  }

  const installed: AddResult[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const entry of mdFiles) {
    const fileUrl = entry.download_url as string;
    // Delegate to addPersona via a synthetic single-file gh source so we
    // reuse validation + overwrite handling. Build it as an http source to
    // avoid re-splicing owner/repo/path.
    try {
      const result = await addPersona(fileUrl, opts);
      installed.push(result);
    } catch (err) {
      skipped.push({
        path: entry.path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { installed, skipped };
}

export interface RemoveResult {
  removed: boolean;
  path: string;
  note?: string;
}

/** Remove a user-installed persona. Refuses to touch built-ins. */
export async function removePersona(
  name: string,
  opts: ManagerOptions = {}
): Promise<RemoveResult> {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!safe) throw new Error(`Invalid persona name: ${name}`);
  const dir = opts.userDir ?? userPersonasDir(opts.home);
  const filePath = join(dir, `${safe}.md`);
  try {
    await stat(filePath);
  } catch {
    return {
      removed: false,
      path: filePath,
      note: `No user-installed persona named "${safe}". Built-in personas cannot be removed.`,
    };
  }
  await unlink(filePath);
  return { removed: true, path: filePath };
}

/** List built-in + user personas, with user overriding built-in on collision. */
export async function listAllPersonas(opts: ManagerOptions = {}): Promise<PersonaEntry[]> {
  const builtinDir = opts.builtinDir ?? defaultBuiltinDir();
  const userDir = opts.userDir ?? userPersonasDir(opts.home);
  const builtin = await readMdNames(builtinDir);
  const user = await readMdNames(userDir);
  const map = new Map<string, PersonaEntry>();
  for (const name of builtin) {
    map.set(name, { name, source: "builtin", path: join(builtinDir, `${name}.md`) });
  }
  for (const name of user) {
    map.set(name, { name, source: "user", path: join(userDir, `${name}.md`) });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readMdNames(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => f.replace(/\.md$/i, "").toLowerCase());
  } catch {
    return [];
  }
}

function defaultBuiltinDir(): string {
  // Mirrors personaLoader.defaultPersonasDir() but we can't import it cleanly
  // since that helper is private. Re-derive from this file's location.
  // dist/personasManager.js sits next to dist/personas/, src/personasManager.ts
  // sits next to src/personas/.
  // Use fileURL relative to this module.
  // Note: keep this trivial — tests inject builtinDir directly.
  const url = new URL("./personas/", import.meta.url);
  return url.pathname;
}
