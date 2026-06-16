import { simpleGit, type SimpleGit } from "simple-git";
import type { Commit } from "./git.js";
import { gradeCommit } from "./grader.js";
import { loadPersona } from "./personaLoader.js";
import { roastCommit, resolveConfigFromEnv } from "./roaster.js";
import { loadUserConfig, resolveDefaults } from "./config.js";

export interface RewritePlan {
  /** "amend" when sha resolves to HEAD, otherwise "rebase". */
  mode: "amend" | "rebase";
  /** Resolved full SHA of the target commit. */
  sha: string;
  /** Short SHA for display. */
  shortSha: string;
  /** Original commit subject. */
  originalSubject: string;
  /** Suggested rewritten subject (Conventional Commits style). */
  rewrite: string;
  /** Roast string that justified the rewrite (for context). */
  roast: string;
  /** For "amend": the literal `git commit --amend -m <msg>` command.
   *  For "rebase": a multi-line shell snippet using `git rebase --exec`. */
  command: string;
}

export interface BuildRewritePlanOptions {
  sha: string;
  cwd?: string;
  git?: SimpleGit;
  /** When true, skip dirty-working-tree refusal. */
  force?: boolean;
  /** Inject env (for tests). */
  env?: NodeJS.ProcessEnv;
}

/** Single quote a string for safe shell embedding. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Throws when the working tree has uncommitted changes and force is false. */
export async function assertCleanWorkingTree(
  g: SimpleGit,
  force: boolean | undefined
): Promise<void> {
  if (force) return;
  const status = await g.status();
  if (!status.isClean()) {
    throw new Error(
      "Working tree is dirty. Commit or stash your changes, or pass --force to proceed anyway."
    );
  }
}

/** Build a rewrite plan for a single commit. Does NOT execute anything. */
export async function buildRewritePlan(
  opts: BuildRewritePlanOptions
): Promise<RewritePlan> {
  const { sha, cwd, force, env } = opts;
  const g = opts.git ?? simpleGit(cwd);

  await assertCleanWorkingTree(g, force);

  // Resolve sha -> full sha. Will throw if unknown.
  const fullSha = (await g.revparse([sha])).trim();
  const headSha = (await g.revparse(["HEAD"])).trim();
  const isHead = fullSha === headSha;

  // Pull the commit's metadata via a single, root-commit-safe `git show`.
  const FIELD = "\x1f";
  const format = ["%H", "%s", "%b", "%an", "%aI"].join(FIELD);
  const raw = await g.raw(["show", "-s", `--format=${format}`, fullSha]);
  const [shaOut, subject, body, author, date] = raw.replace(/\n$/, "").split(FIELD);
  if (!shaOut) {
    throw new Error(`Could not read commit ${sha}.`);
  }
  const commit: Commit = {
    sha: fullSha,
    shortSha: fullSha.slice(0, 7),
    subject: (subject ?? "").trim(),
    body: (body ?? "").trim(),
    author: author ?? "",
    date: date ?? "",
  };

  // Reuse the regular roast pipeline to produce a suggested rewrite.
  const userCfg = await loadUserConfig();
  const defaults = resolveDefaults(userCfg);
  const persona = await loadPersona(defaults.persona);
  const grade = gradeCommit(commit);
  const cfg = resolveConfigFromEnv(env ?? process.env, {
    model: defaults.model,
    apiBase: defaults.apiBase,
  });
  const roast = await roastCommit(commit, persona, grade.grade, cfg);

  const mode: RewritePlan["mode"] = isHead ? "amend" : "rebase";
  const command =
    mode === "amend"
      ? `git commit --amend -m ${shellQuote(roast.rewrite)}`
      : buildRebaseExecScript(fullSha, roast.rewrite);

  return {
    mode,
    sha: fullSha,
    shortSha: commit.shortSha,
    originalSubject: commit.subject,
    rewrite: roast.rewrite,
    roast: roast.roast,
    command,
  };
}

/**
 * Generate a `git rebase --exec` snippet that rewrites a single older commit.
 * The user runs it themselves; we never invoke rebase from inside commit-roast.
 */
export function buildRebaseExecScript(fullSha: string, newSubject: string): string {
  const quoted = shellQuote(newSubject);
  return [
    `# Rewrite ${fullSha.slice(0, 7)} in place. Review carefully before running.`,
    `# This rewrites git history from ${fullSha.slice(0, 7)} onward — every commit`,
    `# after it will get a new SHA. Do NOT run this on branches you've already`,
    `# pushed to a shared remote unless you understand --force-with-lease.`,
    `git rebase --exec 'if [ "$(git rev-parse HEAD)" = "${fullSha}" ]; then git commit --amend -m ${quoted}; fi' ${fullSha}~1`,
  ].join("\n");
}

/** Human-readable rendering of a RewritePlan for terminal output. */
export function renderRewritePlan(plan: RewritePlan): string {
  const lines: string[] = [];
  lines.push(`Commit:   ${plan.shortSha} (${plan.mode === "amend" ? "HEAD" : "older commit"})`);
  lines.push(`Original: ${plan.originalSubject}`);
  lines.push(`Proposed: ${plan.rewrite}`);
  lines.push("");
  if (plan.mode === "amend") {
    lines.push("Running this will amend the HEAD commit in place:");
  } else {
    lines.push("commit-roast will NOT rewrite history for you. Run this yourself:");
  }
  lines.push("");
  lines.push(plan.command);
  lines.push("");
  lines.push(
    "⚠️  Rewriting history changes commit SHAs. If you've already pushed these"
  );
  lines.push(
    "    commits to a shared branch, coordinate with your team and use"
  );
  lines.push("    `git push --force-with-lease` rather than `--force`.");
  return lines.join("\n");
}
