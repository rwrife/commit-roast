import { writeFile } from "node:fs/promises";
import type { Commit } from "./git.js";
import { gradeAll, scoreToGrade } from "./stats.js";
import type { Grade } from "./grader.js";

/**
 * Shields.io "endpoint" badge response shape.
 * https://shields.io/badges/endpoint-badge
 */
export interface ShieldsEndpoint {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

/**
 * Grade → shields.io named color. Documented in README.
 *   A → brightgreen
 *   B → green
 *   C → yellowgreen
 *   D → orange
 *   F → red
 */
export function gradeToColor(grade: Grade): string {
  switch (grade) {
    case "A":
      return "brightgreen";
    case "B":
      return "green";
    case "C":
      return "yellowgreen";
    case "D":
      return "orange";
    case "F":
    default:
      return "red";
  }
}

/** Convert a shields.io named color into a hex value for SVG rendering. */
function colorToHex(color: string): string {
  switch (color) {
    case "brightgreen":
      return "#4c1";
    case "green":
      return "#97ca00";
    case "yellowgreen":
      return "#a4a61d";
    case "yellow":
      return "#dfb317";
    case "orange":
      return "#fe7d37";
    case "red":
      return "#e05d44";
    case "lightgrey":
    default:
      return "#9f9f9f";
  }
}

export interface ComputeBadgeOptions {
  /** Overrides for label/message text. */
  label?: string;
}

export interface BadgeData {
  /** Average grade across the supplied commits ("F" when list is empty). */
  grade: Grade;
  /** Average numeric score 0..100 across the supplied commits. */
  score: number;
  /** Number of commits considered. */
  count: number;
  /** Label text on the badge ("commit grade" by default). */
  label: string;
  /** Right-hand badge text. Defaults to the grade letter. */
  message: string;
  /** Shields.io named color derived from `grade`. */
  color: string;
}

/**
 * Score the supplied commits with the rule-based grader, then summarize as
 * everything needed to render a badge. Empty input yields an "F" badge so
 * scripts always emit something useful instead of erroring.
 */
export function computeBadgeData(commits: Commit[], opts: ComputeBadgeOptions = {}): BadgeData {
  const graded = gradeAll(commits);
  const count = graded.length;
  const avgScore =
    count > 0 ? graded.reduce((sum, g) => sum + g.grade.score, 0) / count : 0;
  const grade: Grade = count > 0 ? scoreToGrade(avgScore) : "F";
  return {
    grade,
    score: avgScore,
    count,
    label: opts.label ?? "commit grade",
    message: grade,
    color: gradeToColor(grade),
  };
}

/** Build a shields.io endpoint JSON payload string for the supplied badge data. */
export function buildEndpointJson(data: BadgeData): string {
  const payload: ShieldsEndpoint = {
    schemaVersion: 1,
    label: data.label,
    message: data.message,
    color: data.color,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Approximate text width for the badge SVG. We use a fixed 7px-per-character
 * heuristic instead of measuring with a real font so the SVG stays
 * self-contained (no external font/image refs — see acceptance criteria).
 */
function approxTextWidth(text: string): number {
  // 70 = 10 chars worth of padding + a fudge factor so short labels look right.
  return Math.max(20, text.length * 7);
}

/**
 * Render a self-contained SVG badge. Inline styles, no external font, no
 * external images — works wherever raw SVG can be served, including being
 * committed straight into a repo.
 */
export function buildSvg(data: BadgeData): string {
  const labelW = approxTextWidth(data.label) + 10;
  const messageW = approxTextWidth(data.message) + 10;
  const totalW = labelW + messageW;
  const messageColor = colorToHex(data.color);
  // Center text horizontally in each half; vertical baseline ~14 looks right for h=20.
  const labelX = labelW / 2;
  const messageX = labelW + messageW / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${escapeXml(data.label)}: ${escapeXml(data.message)}">`,
    `  <title>${escapeXml(data.label)}: ${escapeXml(data.message)}</title>`,
    `  <linearGradient id="s" x2="0" y2="100%">`,
    `    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>`,
    `    <stop offset="1" stop-opacity=".1"/>`,
    `  </linearGradient>`,
    `  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `  <g clip-path="url(#r)">`,
    `    <rect width="${labelW}" height="20" fill="#555"/>`,
    `    <rect x="${labelW}" width="${messageW}" height="20" fill="${messageColor}"/>`,
    `    <rect width="${totalW}" height="20" fill="url(#s)"/>`,
    `  </g>`,
    `  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(data.label)}</text>`,
    `    <text x="${labelX}" y="14">${escapeXml(data.label)}</text>`,
    `    <text x="${messageX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(data.message)}</text>`,
    `    <text x="${messageX}" y="14">${escapeXml(data.message)}</text>`,
    `  </g>`,
    `</svg>`,
  ].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface RunBadgeOptions {
  /** Emit SVG instead of shields endpoint JSON. */
  svg?: boolean;
  /** Write to this path on disk instead of stdout. */
  out?: string;
}

export interface RunBadgeResult {
  /** The rendered badge content (JSON or SVG). */
  content: string;
  /** Whether content was written to disk and to what path. */
  writtenTo?: string;
  /** The computed badge data, exposed for callers that want to inspect it. */
  data: BadgeData;
}

/**
 * High-level helper used by bin.ts. Keeps file-system + commit-loading
 * concerns out of the pure functions above so they stay easy to unit-test.
 */
export async function runBadge(
  commits: Commit[],
  opts: RunBadgeOptions = {}
): Promise<RunBadgeResult> {
  const data = computeBadgeData(commits);
  const content = opts.svg ? buildSvg(data) : buildEndpointJson(data);
  if (opts.out) {
    await writeFile(opts.out, content, "utf8");
    return { content, writtenTo: opts.out, data };
  }
  return { content, data };
}
