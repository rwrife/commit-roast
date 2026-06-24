import chalk, { Chalk, type ChalkInstance } from "chalk";
import { VERSION } from "./version.js";
import type { RoastedCommit } from "./bin.js";
import { isBelowThreshold, type Grade } from "./grader.js";

export type RenderMode = "pretty" | "json";

export interface RenderOptions {
  persona: string;
  mode?: RenderMode;
  color?: boolean;
  /** When true, render one terse line per commit (sha + grade + reasons). */
  quiet?: boolean;
  /** When set, items grading worse than this are marked as failedThreshold. */
  threshold?: Grade;
}

function failed(grade: Grade, threshold?: Grade): boolean {
  return threshold !== undefined && isBelowThreshold(grade, threshold);
}

const PERSONA_EMOJI: Record<string, string> = {
  linus: "🐧",
  pm: "📋",
  bard: "🎭",
  teacher: "📚",
};

const GRADE_COLORS: Record<string, (c: ChalkInstance) => ChalkInstance> = {
  A: (c) => c.green.bold,
  B: (c) => c.greenBright,
  C: (c) => c.yellow,
  D: (c) => c.magenta,
  F: (c) => c.red.bold,
};

/**
 * True when colorized output should be suppressed. Honors the explicit
 * `color` flag first, then the conventional `NO_COLOR` env var
 * (https://no-color.org/). Anything truthy in `NO_COLOR` disables color.
 */
export function shouldDisableColor(color: boolean | undefined): boolean {
  if (color === false) return true;
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "") return true;
  return false;
}

export function render(items: RoastedCommit[], opts: RenderOptions): string {
  if (opts.mode === "json") return renderJson(items, opts);
  if (opts.quiet) return renderQuiet(items, opts);
  return renderPretty(items, opts);
}

export function renderJson(
  items: RoastedCommit[],
  optsOrPersona: RenderOptions | string
): string {
  const opts: RenderOptions =
    typeof optsOrPersona === "string" ? { persona: optsOrPersona } : optsOrPersona;
  const payload = {
    version: VERSION,
    persona: opts.persona,
    commits: items.map((item) => {
      const { commit, grade, roast } = item;
      const base = {
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        author: commit.author,
        date: commit.date,
        grade: grade.grade,
        score: grade.score,
        reasons: grade.reasons,
        roast: roast.roast,
        rewrite: roast.rewrite,
        source: roast.source,
        diffIncluded: Boolean(item.diff && item.diff.diff),
        diffBytes: item.diff?.bytes ?? 0,
      };
      return opts.threshold
        ? { ...base, failedThreshold: failed(grade.grade, opts.threshold) }
        : base;
    }),
  };
  return JSON.stringify(payload, null, 2);
}

export function renderQuiet(items: RoastedCommit[], opts: RenderOptions): string {
  const useColor = !shouldDisableColor(opts.color);
  const c: ChalkInstance = useColor ? chalk : new Chalk({ level: 0 });
  const lines: string[] = [];
  for (const { commit, grade } of items) {
    const isFail = failed(grade.grade, opts.threshold);
    const gradePaint = (GRADE_COLORS[grade.grade] ?? ((x: ChalkInstance) => x.white))(c);
    const gradeBadge = gradePaint(` ${grade.grade} `);
    const fail = isFail ? ` ${c.red.bold("FAIL")}` : "";
    const reasons = grade.reasons.length > 0 ? `  ${c.dim(grade.reasons.join("; "))}` : "";
    lines.push(`${gradeBadge}  ${c.dim(commit.shortSha)}${fail}  ${commit.subject}${reasons}`);
  }
  return lines.join("\n");
}

export function renderPretty(items: RoastedCommit[], opts: RenderOptions): string {
  const useColor = !shouldDisableColor(opts.color);
  // chalk@5 honors process.env.FORCE_COLOR/NO_COLOR via its internal level;
  // we create a local instance that respects our explicit toggle.
  const c: ChalkInstance = useColor ? chalk : new Chalk({ level: 0 });
  const emoji = PERSONA_EMOJI[opts.persona.toLowerCase()] ?? "🔥";
  const anyLlm = items.some((i) => i.roast.source === "llm");
  const mode = anyLlm ? c.cyan("llm") : c.gray("offline");
  const header = `${emoji}  ${c.bold("commit-roast")} ${c.dim(`v${VERSION}`)}  ·  persona: ${c.bold(opts.persona)}  ·  ${mode}`;
  const lines: string[] = [header, c.dim("─".repeat(64))];
  for (const { commit, grade, roast } of items) {
    const gradePaint = (GRADE_COLORS[grade.grade] ?? ((x: ChalkInstance) => x.white))(c);
    const gradeBadge = gradePaint(` ${grade.grade} `);
    const fail = failed(grade.grade, opts.threshold) ? ` ${c.red.bold("FAIL")}` : "";
    lines.push(`${gradeBadge}  ${c.dim(commit.shortSha)}${fail}  ${commit.subject}`);
    lines.push(`    ${c.bold("roast")}    ${roast.roast}`);
    lines.push(`    ${c.bold("rewrite")}  ${c.italic(roast.rewrite)}`);
    if (grade.reasons.length > 0) {
      lines.push(`    ${c.dim("notes")}    ${c.dim(grade.reasons.join("; "))}`);
    }
    lines.push("");
  }
  if (!anyLlm) {
    lines.push(c.dim("(offline mode — set ROAST_API_KEY for LLM roasts)"));
  }
  return lines.join("\n").trimEnd();
}
