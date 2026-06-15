import { Command } from "commander";
import { VERSION } from "./version.js";
import { getRecentCommits, type Commit } from "./git.js";
import { gradeCommit, type GradeResult } from "./grader.js";
import { loadPersona } from "./personaLoader.js";
import { roastCommit, resolveConfigFromEnv, type RoastResult } from "./roaster.js";
import { render } from "./render.js";
import { loadUserConfig, resolveDefaults } from "./config.js";

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

  return program;
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
