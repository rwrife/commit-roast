import { Command } from "commander";
import { VERSION } from "./version.js";
import { getRecentCommits, type Commit } from "./git.js";
import { gradeCommit, type GradeResult } from "./grader.js";

interface RoastOptions {
  count: string;
  persona: string;
  since?: string;
  color: boolean;
}

export interface RoastedCommit {
  commit: Commit;
  grade: GradeResult;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("commit-roast")
    .description(
      "Roast your last N git commits with swappable AI personas. Equal parts dev-tool and dunk-tank."
    )
    .version(VERSION, "-v, --version", "print version")
    .option("-c, --count <n>", "number of commits to roast", "5")
    .option("-p, --persona <name>", "persona to use", "linus")
    .option("-s, --since <ref>", "only roast commits since this ref/sha")
    .option("--no-color", "disable colored output")
    .action(async (opts: RoastOptions) => {
      const count = Number(opts.count) || 5;
      const commits = await getRecentCommits({ count, since: opts.since });
      if (commits.length === 0) {
        console.log("No commits found. Nothing to roast. Lucky you.");
        return;
      }
      const roasted: RoastedCommit[] = commits.map((c) => ({
        commit: c,
        grade: gradeCommit(c),
      }));
      console.log(renderRoasts(roasted, opts.persona));
    });

  return program;
}

export function renderRoasts(items: RoastedCommit[], persona: string): string {
  const header = `commit-roast v${VERSION} — persona: ${persona} (rule-based; LLM lands in M3+)`;
  const lines: string[] = [header, ""];
  for (const { commit, grade } of items) {
    lines.push(`${grade.grade}  ${commit.shortSha}  ${commit.subject}`);
    lines.push(`    roast: ${grade.roast}`);
    if (grade.reasons.length > 0) {
      lines.push(`    notes: ${grade.reasons.join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

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
