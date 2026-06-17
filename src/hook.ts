import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import { gradeCommit } from "./grader.js";

export type HookType = "prepare-commit-msg" | "commit-msg";

export const SUPPORTED_HOOKS: HookType[] = ["prepare-commit-msg", "commit-msg"];

/** Marker so we can recognize hooks we installed and safely overwrite/remove them. */
const HOOK_MARKER = "# commit-roast: managed hook (safe to remove)";

export interface InstallOptions {
  type?: HookType;
  /** Repo root (defaults to CWD). */
  cwd?: string;
  /** Overwrite an existing non-commit-roast hook (backs it up to <name>.bak). */
  force?: boolean;
  /** Override the bin invoked by the hook (defaults to `commit-roast`). */
  bin?: string;
}

export interface InstallResult {
  type: HookType;
  path: string;
  /** True if we replaced an existing hook. */
  replaced: boolean;
  /** Path to the backup we created, if any. */
  backupPath?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the repo's hooks directory (respects `core.hooksPath`). */
export async function resolveHooksDir(cwd: string = process.cwd()): Promise<string> {
  const git = simpleGit(cwd);
  // Top-level (works inside subdirs too).
  const top = (await git.revparse(["--show-toplevel"])).trim();
  let hooksPath = "";
  try {
    hooksPath = (await git.raw(["config", "--get", "core.hooksPath"])).trim();
  } catch {
    // not set — fine
  }
  if (hooksPath) {
    return resolve(top, hooksPath);
  }
  // Default: <gitdir>/hooks. `git rev-parse --git-path hooks` handles worktrees.
  const hooks = (await git.raw(["rev-parse", "--git-path", "hooks"])).trim();
  return resolve(top, hooks);
}

function hookScript(bin: string, type: HookType): string {
  // POSIX sh: forward all args to `commit-roast hook run <type> "$@"`.
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by \`commit-roast hook install\`. Remove with \`commit-roast hook uninstall\`.
exec ${bin} hook run --type ${type} -- "$@"
`;
}

async function isManagedHook(path: string): Promise<boolean> {
  try {
    const contents = await readFile(path, "utf8");
    return contents.includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

export async function installHook(opts: InstallOptions = {}): Promise<InstallResult> {
  const type: HookType = opts.type ?? "prepare-commit-msg";
  if (!SUPPORTED_HOOKS.includes(type)) {
    throw new Error(`Unsupported hook type: ${type}. Use one of: ${SUPPORTED_HOOKS.join(", ")}`);
  }
  const hooksDir = await resolveHooksDir(opts.cwd);
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, type);
  const bin = opts.bin ?? "commit-roast";

  let replaced = false;
  let backupPath: string | undefined;

  if (await pathExists(hookPath)) {
    if (await isManagedHook(hookPath)) {
      // Just overwrite — same tool, newer template is fine.
      replaced = true;
    } else if (opts.force) {
      backupPath = `${hookPath}.bak`;
      // If a stale .bak exists, don't clobber a real one — bump to .bak.N.
      let candidate = backupPath;
      let i = 1;
      while (await pathExists(candidate)) {
        candidate = `${hookPath}.bak.${i++}`;
      }
      backupPath = candidate;
      await rename(hookPath, backupPath);
      replaced = true;
    } else {
      throw new Error(
        `Refusing to overwrite existing hook at ${hookPath}. Pass --force to back it up and replace.`
      );
    }
  }

  await writeFile(hookPath, hookScript(bin, type), { mode: 0o755 });
  // writeFile mode is masked by umask — chmod to be sure.
  await chmod(hookPath, 0o755);

  return { type, path: hookPath, replaced, backupPath };
}

export interface UninstallOptions {
  type?: HookType;
  cwd?: string;
  /** Restore a `<hook>.bak` backup file if present. */
  restoreBackup?: boolean;
}

export interface UninstallResult {
  type: HookType;
  path: string;
  removed: boolean;
  restoredFrom?: string;
  note?: string;
}

export async function uninstallHook(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const type: HookType = opts.type ?? "prepare-commit-msg";
  const hooksDir = await resolveHooksDir(opts.cwd);
  const hookPath = join(hooksDir, type);

  if (!(await pathExists(hookPath))) {
    return { type, path: hookPath, removed: false, note: "no hook installed" };
  }

  if (!(await isManagedHook(hookPath))) {
    return {
      type,
      path: hookPath,
      removed: false,
      note: "existing hook was not installed by commit-roast; leaving it alone",
    };
  }

  await rm(hookPath);

  let restoredFrom: string | undefined;
  if (opts.restoreBackup !== false) {
    const backup = `${hookPath}.bak`;
    if (await pathExists(backup)) {
      await rename(backup, hookPath);
      await chmod(hookPath, 0o755);
      restoredFrom = backup;
    }
  }

  return { type, path: hookPath, removed: true, restoredFrom };
}

export interface HookStatus {
  type: HookType;
  path: string;
  installed: boolean;
  managedByCommitRoast: boolean;
}

export async function hookStatus(cwd?: string): Promise<HookStatus[]> {
  const hooksDir = await resolveHooksDir(cwd);
  const out: HookStatus[] = [];
  for (const type of SUPPORTED_HOOKS) {
    const path = join(hooksDir, type);
    const installed = await pathExists(path);
    const managed = installed ? await isManagedHook(path) : false;
    out.push({ type, path, installed, managedByCommitRoast: managed });
  }
  return out;
}

export interface RunHookOptions {
  /** Path to the commit message file (arg 1 from git). */
  messageFile: string;
  /** prepare-commit-msg source (arg 2), e.g. "message", "template", "merge", "squash", "commit". */
  source?: string;
  /** Which hook this is (we behave slightly differently). */
  type: HookType;
}

export interface RunHookResult {
  /** True if we appended/printed roast feedback. */
  graded: boolean;
  /** Reason we skipped, if any. */
  skipped?: string;
  /** Lines that would be printed to the user (also returned for tests). */
  output: string[];
}

/**
 * Execute the hook against a commit message file:
 *   1. Read the current message.
 *   2. Grade it with the rule-based grader (no LLM calls — keep commits fast).
 *   3. For prepare-commit-msg: append a commented roast block to the message file
 *      (lines starting with `#` are stripped by git, so they're cosmetic editor hints).
 *   4. Print the roast to stderr so the user actually sees it.
 *
 * Returns rather than `process.exit`ing so tests can assert behavior.
 */
export async function runHook(opts: RunHookOptions): Promise<RunHookResult> {
  // Skip generated messages where roasting is noise.
  if (opts.type === "prepare-commit-msg" && opts.source) {
    const skipSources = new Set(["merge", "squash", "commit"]);
    if (skipSources.has(opts.source)) {
      return { graded: false, skipped: `source=${opts.source}`, output: [] };
    }
  }

  const raw = await readFile(opts.messageFile, "utf8");
  const { subject, body } = splitMessage(raw);

  if (!subject.trim()) {
    // Nothing to grade yet (e.g. fresh prepare-commit-msg with empty template).
    return { graded: false, skipped: "empty subject", output: [] };
  }

  const result = gradeCommit({
    sha: "",
    shortSha: "",
    subject,
    body,
    author: "",
    date: "",
  });

  const lines: string[] = [];
  lines.push(`commit-roast: grade ${result.grade} (${result.score}/100)`);
  lines.push(`  > ${result.roast}`);
  for (const reason of result.reasons) {
    lines.push(`  - ${reason}`);
  }

  // Stderr is visible during `git commit -m ...` (commit-msg) and right
  // before the editor opens (prepare-commit-msg).
  for (const line of lines) process.stderr.write(`${line}\n`);

  // For prepare-commit-msg, also drop the same info into the message file
  // as `#`-prefixed lines so the user sees it inside the editor. Git strips
  // these before recording the commit, so they don't pollute history.
  if (opts.type === "prepare-commit-msg") {
    const commented =
      "\n" +
      lines.map((l) => `# ${l}`).join("\n") +
      "\n# (lines starting with '#' are stripped by git)\n";
    // Only append if not already appended (avoid duplicates on re-invocation).
    if (!raw.includes("# commit-roast: grade ")) {
      await writeFile(opts.messageFile, raw + commented);
    }
  }

  return { graded: true, output: lines };
}

/** Strip git's `#`-prefixed comment lines, then split subject/body. */
export function splitMessage(raw: string): { subject: string; body: string } {
  const cleaned = raw
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n");
  // Drop any leading blank lines so the subject is the first real line.
  const trimmedLead = cleaned.replace(/^\s*\n+/, "");
  const firstBreak = trimmedLead.indexOf("\n");
  if (firstBreak === -1) return { subject: trimmedLead.trim(), body: "" };
  const subject = trimmedLead.slice(0, firstBreak).trim();
  const body = trimmedLead.slice(firstBreak + 1).trim();
  return { subject, body };
}

// Re-export internals used by tests.
export const __test__ = { HOOK_MARKER, hookScript, isManagedHook, dirname };
