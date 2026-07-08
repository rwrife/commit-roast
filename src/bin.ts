import { Command } from "commander";
import { VERSION } from "./version.js";
import { getRecentCommits, getCommitDiff, type Commit, type CommitDiff } from "./git.js";
import { gradeCommit, isBelowThreshold, normalizeGrade, type Grade, type GradeResult } from "./grader.js";
import { loadPersona } from "./personaLoader.js";
import { roastCommit, resolveConfigFromEnv, type RoastResult } from "./roaster.js";
import { render } from "./render.js";
import { loadUserConfig, resolveDefaults } from "./config.js";
import { buildRewritePlan, renderRewritePlan } from "./rewrite.js";
import { gradeAll, summarize, renderStats } from "./stats.js";
import {
  buildReport,
  renderReportJson,
  renderReportMarkdown,
  renderReportHtml,
} from "./report.js";
import {
  parsePrUrl,
  buildTeamRoast,
  formatTeamComment,
  postTeamComment,
} from "./team.js";
import {
  installHook,
  uninstallHook,
  hookStatus,
  runHook,
  SUPPORTED_HOOKS,
  type HookType,
} from "./hook.js";
import { createInterface } from "node:readline/promises";
import { runMcpServer } from "./mcp.js";
import { runInit, renderInitResult } from "./init.js";
import {
  addPersona,
  addPersonasFromRepo,
  listAllPersonas,
  parseSource,
  removePersona,
  userPersonasDir,
} from "./personasManager.js";
import {
  BUILTIN_PRESETS,
  formatUnreachableHint,
  parsePresetFlag,
  pingPresetTarget,
  renderPresetsList,
  resolveRoasterTarget,
} from "./presets.js";
import { RoastCache, makeCacheKey } from "./cache.js";
import { runBadge } from "./badge.js";
import { runWatch } from "./watch.js";
import {
  type BattleEntry,
  type JudgeResult,
  judgeBattle,
  loadBattlePersonas,
  parseBattleFlag,
  runBattle,
  shouldRenderSideBySide,
} from "./battle.js";

interface RoastOptions {
  count?: string;
  persona?: string;
  since?: string;
  color: boolean;
  json?: boolean;
  quiet?: boolean;
  strict?: string | boolean;
  diff?: boolean;
  diffBytes?: string;
  preset?: string;
  model?: string;
  apiBase?: string;
  cache?: boolean;
  battle?: string;
  sideBySide?: boolean;
  judge?: boolean;
}

export interface RoastedCommit {
  commit: Commit;
  grade: GradeResult;
  roast: RoastResult;
  diff?: CommitDiff;
  /** Populated only when `--battle` was active. */
  battle?: BattleEntry[];
  /** Populated only when `--battle --judge` was active. */
  judge?: JudgeResult;
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
    .option("-q, --quiet", "suppress roast/rewrite body; print one line per commit (great for CI)")
    .option(
      "--strict [grade]",
      "exit non-zero if any commit grades below <grade> (A|B|C|D|F; default C)"
    )
    .option(
      "--diff",
      "include a truncated commit diff in the LLM prompt for grounded roasts (uses more tokens)"
    )
    .option(
      "--diff-bytes <n>",
      "soft cap on diff bytes per commit when --diff is set (default 4096)"
    )
    .option(
      "--preset <name>",
      `local-model preset (e.g. ollama, lmstudio); accepts "name:model" (see: commit-roast presets list)`
    )
    .option("--model <model>", "override model name (highest priority)")
    .option("--api-base <url>", "override OpenAI-compatible base URL (highest priority)")
    .option("--no-cache", "bypass the roast cache (no read, no write) for this run")
    .option(
      "--battle <personas>",
      "Roast Battle mode: comma-separated list of 2–4 personas to run against each commit (e.g. linus,pm)"
    )
    .option(
      "--side-by-side",
      "render battle roasts in columns when the terminal is wide enough (≥ 120 cols); auto-falls-back to stacked otherwise"
    )
    .option(
      "--judge",
      "in --battle mode, add one extra LLM call per commit to pick a winner (falls back to offline judge without an API key)"
    )
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
      let threshold: Grade | undefined;
      if (opts.strict !== undefined) {
        const raw = typeof opts.strict === "string" ? opts.strict : "C";
        try {
          threshold = normalizeGrade(raw);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 2;
          return;
        }
      }
      const skipLlm = Boolean(opts.quiet);
      const wantDiff = Boolean(opts.diff) && !skipLlm;
      const diffBytes =
        opts.diffBytes !== undefined ? Math.max(0, Number(opts.diffBytes) || 0) : undefined;
      let battleNames: string[] | undefined;
      if (opts.battle !== undefined) {
        try {
          battleNames = parseBattleFlag(opts.battle);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 2;
          return;
        }
      }
      const persona = await loadPersona(personaName).catch((err) => {
        console.error(`Could not load persona '${personaName}': ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        return null;
      });
      if (!persona) return;
      // Validate every battle persona up front so we fail fast instead of
      // half-way through the first commit.
      let battlePersonas: Awaited<ReturnType<typeof loadBattlePersonas>> | undefined;
      if (battleNames) {
        try {
          battlePersonas = await loadBattlePersonas(battleNames);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return;
        }
      }
      let parsedPreset;
      if (opts.preset) {
        try {
          parsedPreset = parsePresetFlag(opts.preset);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 2;
          return;
        }
      }
      let target;
      try {
        target = resolveRoasterTarget({
          preset: parsedPreset,
          cliModel: opts.model,
          cliApiBase: opts.apiBase,
          rcDefaults: { model: defaults.model, apiBase: defaults.apiBase },
          env: process.env,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
        return;
      }
      // Env still wins for the secret (ROAST_API_KEY) and timeout.
      const cfg = resolveConfigFromEnv(process.env, {
        model: target.model,
        apiBase: target.apiBase,
      });
      // Best-effort liveness check for presets so users get a useful hint
      // instead of silently getting fallback roasts. Never blocks the run.
      if (target.preset && !opts.quiet) {
        const ping = await pingPresetTarget(target.preset);
        if (!ping.ok) {
          console.error(formatUnreachableHint(target.preset, ping.reason));
        }
      }
      const roasted: RoastedCommit[] = [];
      const cacheEnabled = opts.cache !== false && !defaults.cacheDisabled && !skipLlm;
      const cache = cacheEnabled
        ? new RoastCache({ maxEntries: defaults.cacheMaxEntries })
        : null;
      for (const c of commits) {
        const grade = gradeCommit(c);
        const diff = wantDiff
          ? await getCommitDiff(c.sha, diffBytes !== undefined ? { maxBytes: diffBytes } : {}).catch(
              () => undefined
            )
          : undefined;
        let roast: RoastResult;
        if (skipLlm) {
          roast = { roast: grade.roast, rewrite: c.subject, source: "offline" as const };
        } else {
          const cacheKey = cache
            ? makeCacheKey({
                commitSha: c.sha,
                persona: persona.name,
                model: cfg.model ?? "",
              })
            : null;
          const cached = cache && cacheKey ? await cache.get(cacheKey) : undefined;
          if (cached) {
            roast = { roast: cached.roast, rewrite: cached.rewrite, source: "cache" };
          } else {
            roast = await roastCommit(c, persona, grade.grade, cfg, diff ? { diff } : {});
            if (cache && cacheKey && roast.source === "llm") {
              await cache.set(cacheKey, { roast: roast.roast, rewrite: roast.rewrite });
            }
          }
        }
        let battle: BattleEntry[] | undefined;
        let judge: JudgeResult | undefined;
        if (battlePersonas) {
          battle = await runBattle({
            commit: c,
            personas: battlePersonas,
            grade: grade.grade,
            config: cfg,
            cache,
            diff: diff ?? undefined,
            offline: skipLlm,
          });
          if (opts.judge && !skipLlm && battle.length >= 2) {
            judge = await judgeBattle({ commit: c, entries: battle, config: cfg });
          }
        }
        roasted.push({ commit: c, grade, roast, diff, battle, judge });
      }
      if (cache) await cache.flush();
      const sideBySide = shouldRenderSideBySide(
        opts.sideBySide,
        process.stdout.columns,
        battlePersonas?.length ?? 0
      );
      console.log(
        render(roasted, {
          persona: persona.name,
          mode: opts.json ? "json" : "pretty",
          color: opts.color,
          quiet: opts.quiet,
          threshold,
          battle: Boolean(battlePersonas),
          sideBySide,
        })
      );
      if (threshold) {
        const failures = roasted.filter((r) => isBelowThreshold(r.grade.grade, threshold!));
        if (failures.length > 0) {
          if (!opts.json) {
            console.error(
              `commit-roast: ${failures.length} commit(s) graded below threshold ${threshold}.`
            );
          }
          process.exitCode = 1;
        }
      }
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
    .command("report")
    .description(
      "Generate a shareable Markdown/HTML/JSON report card of commit hygiene over a date range."
    )
    .option("-s, --since <ref>", "only include commits since this ref/sha or date (e.g. '30 days ago', 2026-06-01)")
    .option("-u, --until <ref>", "only include commits up to this ref/sha or date")
    .option("-a, --author <pattern>", "filter commits by author (forwarded to `git log --author=`)")
    .option("-p, --persona <name>", "persona to use for lowlight roasts (default: linus, or from ~/.commit-roastrc)")
    .option("-o, --out <path>", "write the Markdown report to <path> instead of stdout")
    .option("--html <path>", "also write a self-contained HTML report to <path>")
    .option("-l, --lowlights <n>", "include the N lowest-graded commits with roasts (default 0)", "0")
    .option("--json", "emit machine-readable JSON instead of Markdown (to stdout, or to --out)")
    .option("--no-color", "suppress the emoji in the report header (mostly a no-op; here for parity)")
    .action(async function (this: Command, subOpts: {
      since?: string;
      until?: string;
      author?: string;
      persona?: string;
      out?: string;
      html?: string;
      lowlights?: string;
      json?: boolean;
      color: boolean;
    }) {
      // Commander v12 lets the parent action pre-consume shared flags
      // (--since, --json) even for a subcommand. `optsWithGlobals()` merges
      // parent globals in so `commit-roast report --json --since 30d` works
      // regardless of which layer parsed each flag.
      const parentOpts = (this.parent?.opts?.() ?? {}) as Record<string, unknown>;
      const opts = {
        since: subOpts.since ?? (typeof parentOpts.since === "string" ? parentOpts.since : undefined),
        until: subOpts.until,
        author: subOpts.author,
        persona: subOpts.persona ?? (typeof parentOpts.persona === "string" ? parentOpts.persona : undefined),
        out: subOpts.out,
        html: subOpts.html,
        lowlights: subOpts.lowlights,
        json: subOpts.json ?? Boolean(parentOpts.json),
        color: subOpts.color !== false && parentOpts.color !== false,
      };
      try {
        const userCfg = await loadUserConfig();
        const defaults = resolveDefaults(userCfg);
        const lowlights = Math.max(0, Math.floor(Number(opts.lowlights ?? "0") || 0));
        let persona;
        if (lowlights > 0) {
          const personaName = opts.persona ?? defaults.persona;
          persona = await loadPersona(personaName).catch((err) => {
            console.error(
              `Could not load persona '${personaName}': ${err instanceof Error ? err.message : err}`
            );
            process.exitCode = 1;
            return null;
          });
          if (!persona) return;
        }
        const cfg = resolveConfigFromEnv(process.env, {
          model: defaults.model,
          apiBase: defaults.apiBase,
        });
        const data = await buildReport({
          since: opts.since,
          until: opts.until,
          author: opts.author,
          lowlights,
          persona: persona ?? undefined,
          config: cfg,
        });
        // `--no-color` is here for CLI parity; report output is plain text.
        void opts.color;
        const primary = opts.json ? renderReportJson(data) : renderReportMarkdown(data);
        if (opts.out) {
          const { writeFile, mkdir } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await mkdir(dirname(opts.out), { recursive: true });
          await writeFile(opts.out, primary, "utf8");
          console.log(`wrote ${opts.out}`);
        } else {
          console.log(primary);
        }
        if (opts.html) {
          const html = renderReportHtml(data);
          const { writeFile, mkdir } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await mkdir(dirname(opts.html), { recursive: true });
          await writeFile(opts.html, html, "utf8");
          console.log(`wrote ${opts.html}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  program
    .command("team <prUrl>")
    .description(
      "Roast every commit on a GitHub PR and (optionally) post a rolled-up comment. Requires `gh` for API access."
    )
    .option("-p, --persona <name>", "persona to use (default: linus, or from ~/.commit-roastrc)")
    .option("--dry-run", "print the comment Markdown instead of posting it")
    .option("--json", "emit machine-readable JSON instead of Markdown")
    .action(
      async (
        prUrl: string,
        opts: { persona?: string; dryRun?: boolean; json?: boolean }
      ) => {
        try {
          const ref = parsePrUrl(prUrl);
          const userCfg = await loadUserConfig();
          const defaults = resolveDefaults(userCfg);
          const personaName = opts.persona ?? defaults.persona;
          const cfg = resolveConfigFromEnv(process.env, {
            model: defaults.model,
            apiBase: defaults.apiBase,
          });
          const result = await buildTeamRoast({ ref, personaName, config: cfg });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          const body = formatTeamComment(result);
          if (opts.dryRun) {
            console.log(body);
            return;
          }
          const url = await postTeamComment({ ref, body });
          console.log(url ? `Posted: ${url}` : "Comment posted.");
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
      }
    );

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

  program
    .command("init")
    .description(
      "Bootstrap a repo for commit-roast: install the prepare-commit-msg hook, drop a Conventional Commits cheatsheet, and write a project-local .commit-roastrc."
    )
    .option("--no-hook", "skip installing the git hook")
    .option("--no-cheatsheet", "skip writing COMMIT_CHEATSHEET.md")
    .option("-p, --persona <name>", "persona to bake into .commit-roastrc (default: linus)")
    .option("--model <model>", "default model name to bake into .commit-roastrc")
    .option("-f, --force", "overwrite an existing .commit-roastrc, cheatsheet, or hook")
    .action(
      async (opts: {
        hook: boolean;
        cheatsheet: boolean;
        persona?: string;
        model?: string;
        force?: boolean;
      }) => {
        try {
          const result = await runInit({
            noHook: !opts.hook,
            noCheatsheet: !opts.cheatsheet,
            persona: opts.persona,
            model: opts.model,
            force: opts.force,
          });
          console.log(renderInitResult(result));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
      }
    );

  const personas = program
    .command("personas")
    .description(
      "Manage user-installed personas in ~/.commit-roast/personas/. User personas override built-ins on name collision."
    );

  personas
    .command("add <source>")
    .description(
      "Install a persona. Accepts gh:owner/repo (bulk install every personas/*.md), gh:owner/repo[@ref]/path.md (single file), an https:// raw URL, or a local file path."
    )
    .option("-f, --force", "overwrite an existing user-installed persona with the same name")
    .option(
      "--ref <ref>",
      "branch, tag, or commit SHA to use for gh: sources (overrides @ref in the source string; defaults to the repo's default branch)"
    )
    .action(async (source: string, opts: { force?: boolean; ref?: string }) => {
      try {
        const parsed = parseSource(source, { ref: opts.ref });
        if (parsed.kind === "gh-dir") {
          const result = await addPersonasFromRepo(source, {
            overwrite: opts.force,
            ref: opts.ref,
          });
          if (result.installed.length === 0 && result.skipped.length === 0) {
            console.log("No personas installed.");
            return;
          }
          for (const r of result.installed) {
            console.log(`Installed persona "${r.name}" -> ${r.path}`);
          }
          for (const s of result.skipped) {
            console.log(`Skipped ${s.path}: ${s.reason}`);
          }
          const failed = result.skipped.length;
          const installed = result.installed.length;
          console.log(
            `\nDone: ${installed} installed, ${failed} skipped.` +
              (failed ? " Re-run with --force to overwrite conflicts." : "")
          );
          if (installed === 0 && failed > 0) {
            process.exitCode = 1;
          }
          return;
        }
        const result = await addPersona(source, {
          overwrite: opts.force,
          ref: opts.ref,
        });
        console.log(`Installed persona "${result.name}" -> ${result.path}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  personas
    .command("list")
    .description("List built-in and user-installed personas.")
    .action(async () => {
      try {
        const entries = await listAllPersonas();
        if (entries.length === 0) {
          console.log("No personas found.");
          return;
        }
        for (const e of entries) {
          console.log(`${e.name.padEnd(20)} ${e.source.padEnd(8)} ${e.path}`);
        }
        console.log(`\nUser personas dir: ${userPersonasDir()}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  personas
    .command("remove <name>")
    .description("Remove a user-installed persona. Built-ins cannot be removed.")
    .action(async (name: string) => {
      try {
        const result = await removePersona(name);
        if (!result.removed) {
          console.log(result.note ?? `Nothing to remove at ${result.path}.`);
          return;
        }
        console.log(`Removed persona "${name}" (${result.path}).`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  const presetsCmd = program
    .command("presets")
    .description("Inspect built-in local-model presets used by --preset.");

  presetsCmd
    .command("list")
    .description("List built-in presets with their base URL and default model.")
    .action(() => {
      console.log(renderPresetsList(BUILTIN_PRESETS));
    });

  const cacheCmd = program
    .command("cache")
    .description(
      "Inspect or clear the on-disk roast cache (~/.commit-roast/cache/roasts.json)."
    );

  cacheCmd
    .command("stats")
    .description("Show entry count, on-disk size, and rolling hit rate.")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts: { json?: boolean }) => {
      const userCfg = await loadUserConfig();
      const defaults = resolveDefaults(userCfg);
      const cache = new RoastCache({ maxEntries: defaults.cacheMaxEntries });
      const s = await cache.stats();
      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      const pct = (s.hitRate * 100).toFixed(1);
      console.log(`path:    ${s.path}`);
      console.log(`entries: ${s.entries}`);
      console.log(`size:    ${s.bytes} bytes`);
      console.log(`hits:    ${s.hits}`);
      console.log(`misses:  ${s.misses}`);
      console.log(`hitRate: ${pct}%`);
    });

  cacheCmd
    .command("clear")
    .description("Empty the roast cache.")
    .action(async () => {
      const userCfg = await loadUserConfig();
      const defaults = resolveDefaults(userCfg);
      const cache = new RoastCache({ maxEntries: defaults.cacheMaxEntries });
      await cache.clear();
      console.log(`Cleared cache at ${cache.path}.`);
    });

  program
    .command("badge")
    .description(
      "Generate a shields.io endpoint JSON (or self-contained SVG) for the rolling commit grade. Pure offline rule-based grader — no network, no LLM."
    )
    .option("-c, --count <n>", "number of commits to include (default: 20)", "20")
    .option("-s, --since <ref>", "only include commits since this ref/sha")
    .option("--svg", "emit a self-contained SVG instead of shields endpoint JSON")
    .option("--out <path>", "write to this file instead of stdout")
    .action(
      async (opts: { count?: string; since?: string; svg?: boolean; out?: string }) => {
        try {
          const count = Math.max(1, Number(opts.count) || 20);
          const commits = await getRecentCommits({ count, since: opts.since });
          const result = await runBadge(commits, { svg: opts.svg, out: opts.out });
          if (result.writtenTo) {
            console.log(`Wrote badge to ${result.writtenTo}`);
          } else {
            console.log(result.content);
          }
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
      }
    );

  program
    .command("watch")
    .description(
      "Poll the current (or --branch) HEAD and roast every new commit as it lands. Ctrl-C to stop; prints a session summary on exit."
    )
    .option("-b, --branch <name>", "branch to watch (default: current HEAD)")
    .option("-p, --persona <name>", "persona to use (default: linus, or from ~/.commit-roastrc)")
    .option("-i, --interval <ms>", "poll interval in milliseconds (default: 2000)", "2000")
    .option("--json", "emit machine-readable JSON per commit and for the exit summary")
    .option("--no-color", "disable colored output")
    .option(
      "--diff",
      "include a truncated diff in the LLM prompt for grounded roasts (uses more tokens)"
    )
    .option(
      "--diff-bytes <n>",
      "soft cap on diff bytes per commit when --diff is set (default 4096)"
    )
    .action(
      async (opts: {
        branch?: string;
        persona?: string;
        interval?: string;
        json?: boolean;
        color: boolean;
        diff?: boolean;
        diffBytes?: string;
      }) => {
        const userCfg = await loadUserConfig();
        const defaults = resolveDefaults(userCfg);
        try {
          await runWatch({
            branch: opts.branch,
            persona: opts.persona ?? defaults.persona,
            interval: opts.interval,
            json: opts.json,
            color: opts.color,
            diff: opts.diff,
            diffBytes:
              opts.diffBytes !== undefined ? Math.max(0, Number(opts.diffBytes) || 0) : undefined,
          });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
      }
    );

  program
    .command("mcp")
    .description(
      "Run commit-roast as a Model Context Protocol (MCP) server over stdio. Exposes `roast`, `grade`, and `rewrite` tools to MCP-capable clients (Claude Desktop, Cursor, OpenClaw, etc)."
    )
    .action(async () => {
      try {
        await runMcpServer();
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
