import chalk, { Chalk, type ChalkInstance } from "chalk";
import { VERSION } from "./version.js";
import type { RoastedCommit } from "./bin.js";
import { isBelowThreshold, type Grade } from "./grader.js";
import type { BattleEntry } from "./battle.js";

export type RenderMode = "pretty" | "json";

export interface RenderOptions {
  persona: string;
  mode?: RenderMode;
  color?: boolean;
  /** When true, render one terse line per commit (sha + grade + reasons). */
  quiet?: boolean;
  /** When set, items grading worse than this are marked as failedThreshold. */
  threshold?: Grade;
  /** When true, the caller ran `--battle`; render battle blocks per commit. */
  battle?: boolean;
  /** When true (and battle is on), render battle roasts as columns. */
  sideBySide?: boolean;
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
      const withThreshold = opts.threshold
        ? { ...base, failedThreshold: failed(grade.grade, opts.threshold) }
        : base;
      // Only emit battle/judge keys when the caller opted in — keeps the
      // non-battle JSON schema identical to previous releases.
      const withBattle = item.battle
        ? { ...withThreshold, battle: item.battle }
        : withThreshold;
      const withJudge = item.judge
        ? { ...withBattle, judge: item.judge }
        : withBattle;
      return withJudge;
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
  const battleActive = Boolean(opts.battle);
  const battleTag = battleActive ? `  ·  ${c.magenta.bold("battle")}` : "";
  const header = `${emoji}  ${c.bold("commit-roast")} ${c.dim(`v${VERSION}`)}  ·  persona: ${c.bold(opts.persona)}  ·  ${mode}${battleTag}`;
  const lines: string[] = [header, c.dim("─".repeat(64))];
  for (const item of items) {
    const { commit, grade, roast } = item;
    const gradePaint = (GRADE_COLORS[grade.grade] ?? ((x: ChalkInstance) => x.white))(c);
    const gradeBadge = gradePaint(` ${grade.grade} `);
    const fail = failed(grade.grade, opts.threshold) ? ` ${c.red.bold("FAIL")}` : "";
    lines.push(`${gradeBadge}  ${c.dim(commit.shortSha)}${fail}  ${commit.subject}`);
    if (battleActive && item.battle && item.battle.length > 0) {
      lines.push(renderBattleBlock(item.battle, c, Boolean(opts.sideBySide)));
      if (item.judge) {
        lines.push(renderJudgeLine(item.judge, c));
      }
    } else {
      lines.push(`    ${c.bold("roast")}    ${roast.roast}`);
      lines.push(`    ${c.bold("rewrite")}  ${c.italic(roast.rewrite)}`);
    }
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

function renderBattleBlock(
  entries: BattleEntry[],
  c: ChalkInstance,
  sideBySide: boolean
): string {
  if (sideBySide && entries.length >= 2) {
    return renderBattleColumns(entries, c);
  }
  return renderBattleStacked(entries, c);
}

function renderBattleStacked(entries: BattleEntry[], c: ChalkInstance): string {
  const out: string[] = [];
  for (const e of entries) {
    const label = c.magenta.bold(padRight(e.persona, 10));
    out.push(`    ${label} ${c.bold("roast")}    ${e.roast}`);
    out.push(`    ${" ".repeat(10)} ${c.bold("rewrite")}  ${c.italic(e.rewrite)}`);
  }
  return out.join("\n");
}

/**
 * Two-column battle rendering. Only used when the caller already decided
 * the terminal is wide enough (see {@link RenderOptions.sideBySide}).
 * For 3+ personas we fall back to 2 columns per row so each cell stays
 * legible instead of squeezing everything into ~30 char slivers.
 */
function renderBattleColumns(entries: BattleEntry[], c: ChalkInstance): string {
  // Available width after the 4-space indent. Cap so a 300-col terminal
  // doesn't produce absurdly wide lines that are painful to eyeball.
  const rawCols = typeof process.stdout.columns === "number" ? process.stdout.columns : 120;
  const totalWidth = Math.max(60, Math.min(rawCols, 200)) - 4;
  const colWidth = Math.floor((totalWidth - 3) / 2); // 3 chars for " │ " separator
  const sep = c.dim(" │ ");
  const out: string[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const left = entries[i]!;
    const right = entries[i + 1];
    const leftLines = formatBattleCell(left, c, colWidth);
    const rightLines = right ? formatBattleCell(right, c, colWidth) : ["".padEnd(colWidth)];
    const rows = Math.max(leftLines.length, rightLines.length);
    for (let r = 0; r < rows; r += 1) {
      const l = leftLines[r] ?? padVisible("", colWidth);
      const rr = rightLines[r] ?? padVisible("", colWidth);
      out.push(`    ${l}${sep}${rr}`);
    }
    if (i + 2 < entries.length) out.push("");
  }
  return out.join("\n");
}

function formatBattleCell(entry: BattleEntry, c: ChalkInstance, width: number): string[] {
  const header = c.magenta.bold(entry.persona);
  const roastLabel = c.bold("roast");
  const rewriteLabel = c.bold("rewrite");
  const lines: string[] = [];
  lines.push(padVisible(header, width));
  for (const line of wrapPlain(`${entry.roast}`, width)) {
    lines.push(padVisible(line, width));
  }
  lines.push(padVisible(`${roastLabel}`, width));
  // Wrap the rewrite too — rewrites can easily exceed a ~55 char column.
  for (const line of wrapPlain(entry.rewrite, width)) {
    lines.push(padVisible(c.italic(line), width));
  }
  lines.push(padVisible(rewriteLabel, width));
  return lines;
}

/** Wrap plain text (no ANSI expected) at whitespace, hard-splitting long tokens. */
function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/);
  const rows: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!w) continue;
    if (w.length > width) {
      if (cur) rows.push(cur);
      for (let i = 0; i < w.length; i += width) rows.push(w.slice(i, i + width));
      cur = "";
      continue;
    }
    if (!cur) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur += ` ${w}`;
    } else {
      rows.push(cur);
      cur = w;
    }
  }
  if (cur) rows.push(cur);
  return rows.length > 0 ? rows : [""];
}

/** Right-pad a string to `width`, ignoring ANSI escape sequences for length. */
function padVisible(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - stripped.length);
  return s + " ".repeat(pad);
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function renderJudgeLine(
  judge: NonNullable<RoastedCommit["judge"]>,
  c: ChalkInstance
): string {
  const src = judge.source === "llm" ? c.cyan("llm") : c.gray(judge.source);
  return `    ${c.yellow.bold("judge")}    🏆 ${c.bold(judge.winner)} — ${judge.reason} ${c.dim(`(${src})`)}`;
}
