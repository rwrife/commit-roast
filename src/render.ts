import chalk, { Chalk, type ChalkInstance } from "chalk";
import { VERSION } from "./version.js";
import type { RoastedCommit } from "./bin.js";

export type RenderMode = "pretty" | "json";

export interface RenderOptions {
  persona: string;
  mode?: RenderMode;
  color?: boolean;
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
  if (opts.mode === "json") return renderJson(items, opts.persona);
  return renderPretty(items, opts);
}

export function renderJson(items: RoastedCommit[], persona: string): string {
  const payload = {
    version: VERSION,
    persona,
    commits: items.map(({ commit, grade, roast }) => ({
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
    })),
  };
  return JSON.stringify(payload, null, 2);
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
    lines.push(`${gradeBadge}  ${c.dim(commit.shortSha)}  ${commit.subject}`);
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
