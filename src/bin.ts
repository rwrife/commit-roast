import { Command } from "commander";
import { VERSION } from "./version.js";
import { getRecentCommits, type Commit } from "./git.js";
import { gradeCommit, type GradeResult } from "./grader.js";
import { loadPersona } from "./personaLoader.js";
import { roastCommit, resolveConfigFromEnv, type RoastResult } from "./roaster.js";
import { render } from "./render.js";
import { loadUserConfig, resolveDefaults } from "./config.js";
import { buildRewritePlan, renderRewritePlan } from "./rewrite.js";
import { gradeAll, summarize, renderStats } from "./stats.js";
import {
  installHook,
  uninstallHook,
  hookStatus,
  runHook,
  SUPPORTED_HOOKS,
  type HookType,
} from "./hook.js";
import { createInterface } from "node:readline/promises";

interface RoastOptions {
  count?: string;
  persona?: string;
  since?: string;
  color: boolean;
  json?: boolean;
}

export interface RoastedCommit {
  commit: Commit;
  grade: GradeResult;
  roast: RoastResult;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("commit-roast")
    .description(
      "Roast your last N git commits with swappable AI personas. Equal parts dev-tool and dunk-tank."
    )
    .version(VERSION, "-v, --version", "print version")
    // No commander defaults here — defaults come from ~/.commit-roastrc
    // (then fall back to built-ins in src/config.ts) so we can tell whether
    // the user actually passed a flag.
    .option("-c, --count <n>", "number of commits to roast (default: 5, or from ~/.commit-roastrc)")
    .option("-p, --persona <name>", "persona to use (default: linus, or from ~/.commit-roastrc)")
    .option("-s, --since <ref>", "only roast commits since this ref/sha")
    .option("--no-color", "disable colored output")
    .option("--json", "emit machine-readable JSON instead of pretty text")
    .action(async (opts: RoastOptions) => {
      const userCfg = await loadUserConfig();
      const defaults = resolveDefaults(userCfg);
      const personaName = opts.persona ?? defaults.persona;
      const count = opts.count !== undefined ? Number(opts.count) || defaults.count : defaults.count;
      const commits = await getRecentCommits({ count, since: opts.since });
      if (commits.length === 0) {
        console.log("No commits found. Nothing to roast. Lucky you.");
        return;
      }
      const persona = await loadPersona(personaName).catch((err) => {
        console.error(`Could not load persona '${personaName}': ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        return null;
      });
      if (!persona) return;
      // Env wins for secrets; rc file supplies non-secret defaults like model/apiBase.
      const cfg = resolveConfigFromEnv(process.env, { model: defaults.model, apiBase: defaults.apiBase });
      const roasted: RoastedCommit[] = [];
      for (const c of commits) {
        const grade = gradeCommit(c);
        const roast = await roastCommit(c, persona, grade.grade, cfg);
        roasted.push({ commit: c, grade, roast });
      }
      console.log(
        render(roasted, {
          persona: persona.name,
          mode: opts.json ? "json" : "pretty",
          color: opts.color,
        })
      );
    });

  program
    .command("stats")
    .description(
      "Score recent commits and show grade distribution, trend sparkline, best/worst, and per-author breakdown."
    )
    .option("-c, --count <n>", "number of commits to include (default: 20, or from ~/.commit-roastrc)")
    .option("-s, --since <ref>", "only include commits since this ref/sha")
    .option("--json", "emit machine-readable JSON instead of pretty text")
    .action(async (opts: { count?: string; since?: string; json?: boolean }) => {
      const userCfg = await loadUserConfig();
      const defaults = resolveDefaults(userCfg);
      // Stats is more useful over a longer window than the default roast count.
      const count = opts.count !== undefined
        ? Number(opts.count) || 20
        : Math.max(defaults.count, 20);
      const commits = await getRecentCommits({ count, since: opts.since });
      const graded = gradeAll(commits);
      const summary = summarize(graded);
      console.log(renderStats(summary, { mode: opts.json ? "json" : "pretty" }));
    });

  program
    .command("rewrite <sha>")
    .description(
      "Show a suggested rewrite for <sha>. For HEAD, offers to run `git commit --amend`; for older commits, emits a `git rebase --exec` script."
    )
    .option("-y, --yes", "skip the confirmation prompt (only meaningful for HEAD)")
    .option("-f, --force", "proceed even when the working tree is dirty")
    .action(async (sha: string, opts: { yes?: boolean; force?: boolean }) => {
      try {
        const plan = await buildRewritePlan({ sha, force: opts.force });
        console.log(renderRewritePlan(plan));
        if (plan.mode !== "amend") {
          // We never rewrite non-HEAD history ourselves. User runs the script.
          return;
        }
        if (!opts.yes) {
          const proceed = await confirm("\nAmend HEAD with the proposed subject? [y/N] ");
          if (!proceed) {
            console.log("Aborted. Nothing was changed.");
            return;
          }
        }
        const { simpleGit } = await import("simple-git");
        await simpleGit().raw(["commit", "--amend", "-m", plan.rewrite]);
        console.log(`Amended ${plan.shortSha}.`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  const hook = program
    .command("hook")
    .description(
      "Manage the prepare-commit-msg / commit-msg git hook that roasts commits at commit time."
    );

  hook
    .command("install")
    .description("Install commit-roast as a git hook in the current repo.")
    .option(
      "-t, --type <type>",
      `hook type to install (${SUPPORTED_HOOKS.join("|")})`,
      "prepare-commit-msg"
    )
    .option("-f, --force", "replace an existing non-commit-roast hook (backs it up)")
    .option("--bin <bin>", "command to exec from the hook script", "commit-roast")
    .action(async (opts: { type: string; force?: boolean; bin?: string }) => {
      try {
        const result = await installHook({
          type: opts.type as HookType,
          force: opts.force,
          bin: opts.bin,
        });
        const verb = result.replaced ? "Replaced" : "Installed";
        console.log(`${verb} ${result.type} hook at ${result.path}`);
        if (result.backupPath) {
          console.log(`Previous hook backed up to ${result.backupPath}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  hook
    .command("uninstall")
    .description("Remove commit-roast's git hook (restores any .bak backup).")
    .option(
      "-t, --type <type>",
      `hook type to remove (${SUPPORTED_HOOKS.join("|")})`,
      "prepare-commit-msg"
    )
    .option("--no-restore-backup", "do not restore a <hook>.bak file if one exists")
    .action(async (opts: { type: string; restoreBackup: boolean }) => {
      try {
        const result = await uninstallHook({
          type: opts.type as HookType,
          restoreBackup: opts.restoreBackup,
        });
        if (!result.removed) {
          console.log(`No commit-roast hook removed (${result.note ?? "nothing to do"}).`);
          return;
        }
        console.log(`Removed ${result.type} hook at ${result.path}`);
        if (result.restoredFrom) {
          console.log(`Restored previous hook from ${result.restoredFrom}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  hook
    .command("status")
    .description("Show which commit-roast hooks are installed in this repo.")
    .action(async () => {
      try {
        const rows = await hookStatus();
        for (const row of rows) {
          const state = !row.installed
            ? "not installed"
            : row.managedByCommitRoast
              ? "installed (commit-roast)"
              : "installed (other tool)";
          console.log(`${row.type.padEnd(20)} ${state}  ${row.path}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  // Internal: invoked by the hook script git calls. Not in --help users care about,
  // but documented in README.
  hook
    .command("run")
    .description("(Internal) Run the hook against a commit message file. Called by git.")
    .option(
      "-t, --type <type>",
      `hook type being executed (${SUPPORTED_HOOKS.join("|")})`,
      "prepare-commit-msg"
    )
    .argument("<messageFile>", "path to .git/COMMIT_EDITMSG")
    .argument("[source]", "prepare-commit-msg source arg from git")
    .argument("[sha]", "commit sha (passed by git for some sources)")
    .action(
      async (
        messageFile: string,
        source: string | undefined,
        _sha: string | undefined,
        opts: { type: string }
      ) => {
        try {
          await runHook({
            messageFile,
            source,
            type: opts.type as HookType,
          });
        } catch (err) {
          // Never block a commit because the roast tool blew up.
          process.stderr.write(
            `commit-roast hook: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }
    );

  return program;
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive: be safe, refuse.
    console.error("Refusing to amend without a TTY. Re-run with --yes if you really mean it.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// Re-exported for backward compatibility with existing imports/tests.
export { render as renderRoasts } from "./render.js";

export function run(argv: string[] = process.argv): void {
  buildProgram().parseAsync(argv).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

// Run when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /commit-roast|bin\.(js|ts|mjs|cjs)$/.test(process.argv[1] ?? "");

if (invokedDirectly) {
  run();
}
