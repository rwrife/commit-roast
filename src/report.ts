import { simpleGit, type SimpleGit } from "simple-git";
import type { Commit } from "./git.js";
import { getRecentCommits } from "./git.js";
import { gradeAll, summarize, type GradedCommit, type StatsSummary } from "./stats.js";
import type { Grade } from "./grader.js";
import { fallbackRoast, roastCommit, type RoasterConfig, type RoastResult } from "./roaster.js";
import { loadPersona, type Persona } from "./personaLoader.js";

export interface ReportOptions {
  since?: string;
  until?: string;
  author?: string;
  /** How many low-graded commits to feature in the "lowlights" section. 0 disables it. */
  lowlights?: number;
  /** How many commits to fetch (defaults to a big cap so date ranges dominate). */
  maxCommits?: number;
  cwd?: string;
  git?: SimpleGit;
  /** Persona used when roasting lowlights (only when lowlights > 0). */
  persona?: Persona;
  /** LLM config; when omitted or missing an apiKey, lowlights fall back to canned roasts. */
  config?: RoasterConfig;
  /** Optional roast fn override, only used in tests. */
  roastFn?: (commit: Commit, persona: Persona, grade: Grade) => Promise<RoastResult>;
  /** Optional now() override so `generatedAt` is deterministic in snapshot tests. */
  now?: () => Date;
}

export interface ReportLowlight {
  commit: Commit;
  grade: Grade;
  score: number;
  roast: string;
  source: RoastResult["source"];
}

export interface ReportData {
  repo: string;
  generatedAt: string;
  since?: string;
  until?: string;
  author?: string;
  total: number;
  summary: StatsSummary;
  lowlights: ReportLowlight[];
  persona?: string;
}

const GRADES: Grade[] = ["A", "B", "C", "D", "F"];

/**
 * Best-effort repo name: origin URL basename, else CWD basename, else "repository".
 */
async function resolveRepoName(g: SimpleGit, cwd?: string): Promise<string> {
  try {
    const url = (await g.raw(["config", "--get", "remote.origin.url"])).trim();
    if (url) {
      const stripped = url.replace(/\.git$/i, "");
      const last = stripped.split(/[\/:]/).filter(Boolean).pop();
      if (last) return last;
    }
  } catch {
    // No origin, no problem.
  }
  const base = (cwd ?? process.cwd()).split(/[\\/]/).filter(Boolean).pop();
  return base || "repository";
}

/**
 * Gather commits, grade them, and (optionally) roast the N lowest-graded for
 * the "lowlights" section. Returns a normalized `ReportData` blob every
 * renderer (markdown/html/json) consumes.
 */
export async function buildReport(opts: ReportOptions = {}): Promise<ReportData> {
  const g = opts.git ?? simpleGit(opts.cwd);
  const repo = await resolveRepoName(g, opts.cwd);
  const maxCommits = opts.maxCommits ?? 5000; // date range is the real filter.

  const commits = await getRecentCommits({
    count: maxCommits,
    since: opts.since,
    until: opts.until,
    author: opts.author,
    cwd: opts.cwd,
    git: g,
  });
  const graded = gradeAll(commits);
  const summary = summarize(graded);

  const wanted = Math.max(0, Math.floor(opts.lowlights ?? 0));
  let lowlights: ReportLowlight[] = [];
  let personaName: string | undefined;
  if (wanted > 0 && graded.length > 0) {
    const persona = opts.persona ?? (await loadPersona("linus"));
    personaName = persona.name;
    // Sort by score ascending; tie-break on subject so snapshot tests are stable.
    const sorted = graded
      .slice()
      .sort(
        (a, b) => a.grade.score - b.grade.score || a.commit.subject.localeCompare(b.commit.subject)
      );
    const picks = sorted.slice(0, wanted);
    lowlights = await Promise.all(
      picks.map(async (gc) => {
        const roast = await roastOne(gc, persona, opts);
        return {
          commit: gc.commit,
          grade: gc.grade.grade,
          score: gc.grade.score,
          roast: roast.roast,
          source: roast.source,
        };
      })
    );
  }

  const now = (opts.now?.() ?? new Date()).toISOString();
  return {
    repo,
    generatedAt: now,
    since: opts.since,
    until: opts.until,
    author: opts.author,
    total: graded.length,
    summary,
    lowlights,
    persona: personaName,
  };
}

async function roastOne(
  gc: GradedCommit,
  persona: Persona,
  opts: ReportOptions
): Promise<RoastResult> {
  if (opts.roastFn) return opts.roastFn(gc.commit, persona, gc.grade.grade);
  if (opts.config && opts.config.apiKey) {
    return roastCommit(gc.commit, persona, gc.grade.grade, opts.config);
  }
  // No key → deterministic canned roast so reports stay useful offline.
  return fallbackRoast(gc.commit, persona, gc.grade.grade);
}

/* ------------------------------------------------------------------------ */
/* Renderers                                                                 */
/* ------------------------------------------------------------------------ */

export function renderReportJson(data: ReportData): string {
  return JSON.stringify(
    {
      repo: data.repo,
      generatedAt: data.generatedAt,
      range: {
        since: data.since ?? null,
        until: data.until ?? null,
        author: data.author ?? null,
      },
      total: data.total,
      average: round1(data.summary.average),
      averageGrade: data.summary.averageGrade,
      distribution: data.summary.distribution,
      sparkline: data.summary.sparkline,
      byAuthor: Object.values(data.summary.byAuthor).map((a) => ({
        author: a.author,
        total: a.total,
        average: round1(a.average),
        averageGrade: a.averageGrade,
        distribution: a.distribution,
      })),
      lowlights: data.lowlights.map((l) => ({
        sha: l.commit.sha,
        shortSha: l.commit.shortSha,
        subject: l.commit.subject,
        author: l.commit.author,
        date: l.commit.date,
        grade: l.grade,
        score: l.score,
        roast: l.roast,
        source: l.source,
      })),
      persona: data.persona ?? null,
    },
    null,
    2
  );
}

export function renderReportMarkdown(data: ReportData): string {
  const lines: string[] = [];
  lines.push(`# 🔥 commit-roast report — ${escapeMd(data.repo)}`);
  lines.push("");
  lines.push(rangeLineMd(data));
  lines.push("");

  if (data.total === 0) {
    lines.push("No commits matched the given filters. Nothing to grade, nothing to roast.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `**Commits:** ${data.total} &nbsp;·&nbsp; **Average:** ${round1(data.summary.average).toFixed(1)} (${data.summary.averageGrade}) &nbsp;·&nbsp; **Trend:** \`${data.summary.sparkline}\``
  );
  lines.push("");

  lines.push("## Grade distribution");
  lines.push("");
  lines.push("| Grade | Count | % |");
  lines.push("| :---: | ---: | ---: |");
  for (const grade of GRADES) {
    const count = data.summary.distribution[grade];
    const pct = data.total === 0 ? 0 : (count / data.total) * 100;
    lines.push(`| ${grade} | ${count} | ${round1(pct).toFixed(1)}% |`);
  }
  lines.push("");

  const authors = Object.values(data.summary.byAuthor).sort((a, b) => b.average - a.average);
  if (authors.length > 0) {
    lines.push("## By author");
    lines.push("");
    lines.push("| Author | Commits | Avg | Grade | A | B | C | D | F |");
    lines.push("| --- | ---: | ---: | :---: | ---: | ---: | ---: | ---: | ---: |");
    for (const a of authors) {
      lines.push(
        `| ${escapeMd(a.author)} | ${a.total} | ${round1(a.average).toFixed(1)} | ${a.averageGrade} | ${a.distribution.A} | ${a.distribution.B} | ${a.distribution.C} | ${a.distribution.D} | ${a.distribution.F} |`
      );
    }
    lines.push("");
  }

  if (data.lowlights.length > 0) {
    lines.push("## Lowlights");
    lines.push("");
    if (data.persona) {
      lines.push(`_Roasted by **${escapeMd(data.persona)}**._`);
      lines.push("");
    }
    for (const l of data.lowlights) {
      lines.push(
        `### ${l.grade} (${l.score}) · \`${l.commit.shortSha}\` — ${escapeMd(l.commit.subject || "(empty subject)")}`
      );
      lines.push("");
      lines.push(`- **Author:** ${escapeMd(l.commit.author || "unknown")}`);
      if (l.commit.date) lines.push(`- **Date:** ${escapeMd(l.commit.date)}`);
      lines.push("");
      lines.push(`> ${escapeMd(l.roast)}`);
      lines.push("");
    }
  }

  lines.push(`_Generated ${escapeMd(data.generatedAt)} by commit-roast._`);
  lines.push("");
  return lines.join("\n");
}

function rangeLineMd(data: ReportData): string {
  const parts: string[] = [];
  if (data.since) parts.push(`since **${escapeMd(data.since)}**`);
  if (data.until) parts.push(`until **${escapeMd(data.until)}**`);
  if (data.author) parts.push(`author **${escapeMd(data.author)}**`);
  return parts.length > 0 ? parts.join(" · ") : "_Full history_";
}

function rangeLinePlain(data: ReportData): string {
  const parts: string[] = [];
  if (data.since) parts.push(`since ${data.since}`);
  if (data.until) parts.push(`until ${data.until}`);
  if (data.author) parts.push(`author ${data.author}`);
  return parts.length > 0 ? parts.join(" · ") : "full history";
}

/* ------------------------------------------------------------------------ */
/* HTML                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Reconstruct oldest→newest scores from the ASCII sparkline. `summarize()`
 * doesn't retain the raw score list; re-fetching git isn't worth it for a
 * visual sparkline, so we map each bar back to its bucket midpoint.
 */
function extractOldestFirstScores(data: ReportData): number[] {
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const bucketSize = 100 / bars.length; // 12.5
  return Array.from(data.summary.sparkline).map((ch) => {
    const idx = bars.indexOf(ch);
    if (idx < 0) return 0;
    return Math.round(idx * bucketSize + bucketSize / 2);
  });
}

/**
 * Bars-style inline SVG sparkline. `fill="currentColor"` inherits the page's
 * text color, which is contrast-checked against the background in the CSS.
 */
export function renderSparklineSvg(scores: number[]): string {
  if (scores.length === 0) return '<span class="spark meta">—</span>';
  const width = Math.max(60, scores.length * 6);
  const height = 22;
  const barW = width / scores.length;
  const pad = 1;
  const bars = scores
    .map((s, i) => {
      const clamped = Math.max(0, Math.min(100, s));
      const h = Math.max(1, Math.round((clamped / 100) * (height - 2)));
      const x = i * barW + pad / 2;
      const y = height - h;
      const w = Math.max(1, barW - pad);
      return `<rect x="${round1(x)}" y="${y}" width="${round1(w)}" height="${h}" rx="0.5"/>`;
    })
    .join("");
  return `<svg class="spark" role="img" aria-label="Commit grade trend" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

const HTML_STYLES = `  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #101418;
    --muted: #4a5560;
    --card: #f5f7fa;
    --border: #d0d7de;
    --accent: #b91c1c;
    --grade-a: #0a7c3a;
    --grade-b: #0e6acf;
    --grade-c: #8a6d00;
    --grade-d: #b45309;
    --grade-f: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101418;
      --fg: #f0f3f5;
      --muted: #a8b0b8;
      --card: #1a2029;
      --border: #2a333d;
      --accent: #f87171;
      --grade-a: #4ade80;
      --grade-b: #60a5fa;
      --grade-c: #fbbf24;
      --grade-d: #fb923c;
      --grade-f: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1.25rem 3rem;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--fg);
    background: var(--bg);
  }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.85rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.25rem; margin: 2rem 0 .75rem; letter-spacing: -0.005em; }
  h3 { font-size: 1.05rem; margin: 1rem 0 .35rem; }
  .subtitle { color: var(--muted); margin: 0 0 1.25rem; }
  .kpis {
    display: flex; flex-wrap: wrap; gap: .75rem;
    padding: 1rem; border: 1px solid var(--border); border-radius: 10px;
    background: var(--card); margin-bottom: 1.5rem;
  }
  .kpi { flex: 1 1 140px; }
  .kpi .label { color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; }
  .kpi .value { font-size: 1.35rem; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--border); }
  th { font-weight: 600; color: var(--muted); font-size: .82rem; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; }
  .grade-A { color: var(--grade-a); font-weight: 700; }
  .grade-B { color: var(--grade-b); font-weight: 700; }
  .grade-C { color: var(--grade-c); font-weight: 700; }
  .grade-D { color: var(--grade-d); font-weight: 700; }
  .grade-F { color: var(--grade-f); font-weight: 700; }
  .spark { display: inline-block; vertical-align: middle; }
  .lowlight {
    padding: .9rem 1rem; border: 1px solid var(--border); border-left: 4px solid var(--accent);
    border-radius: 8px; background: var(--card); margin: .6rem 0;
  }
  .lowlight blockquote {
    margin: .5rem 0 0; padding: .35rem .8rem; border-left: 3px solid var(--muted);
    color: var(--fg); font-style: italic;
  }
  .meta { color: var(--muted); font-size: .85rem; }
  code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: .92em; }
  footer { color: var(--muted); font-size: .8rem; margin-top: 2rem; }`;

/**
 * Emit a single-file HTML report. No external assets, no requests. Sparkline
 * is rendered as inline SVG so it also renders offline in email clients,
 * wikis, and dashboards.
 */
export function renderReportHtml(data: ReportData): string {
  const authors = Object.values(data.summary.byAuthor).sort((a, b) => b.average - a.average);
  const sparkSvg = renderSparklineSvg(extractOldestFirstScores(data));
  const title = `commit-roast report — ${data.repo}`;

  const head = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${HTML_STYLES}
</style>
</head>
<body>
<main>
  <h1>🔥 commit-roast report</h1>
  <p class="subtitle">${escapeHtml(data.repo)} — ${escapeHtml(rangeLinePlain(data))}</p>
`;

  const footer = `  <footer>Generated ${escapeHtml(data.generatedAt)} by commit-roast.</footer>
</main>
</body>
</html>
`;

  if (data.total === 0) {
    return `${head}  <p>No commits matched the given filters. Nothing to grade, nothing to roast.</p>
${footer}`;
  }

  const kpis = `  <section class="kpis" aria-label="Summary">
    <div class="kpi"><div class="label">Commits</div><div class="value">${data.total}</div></div>
    <div class="kpi"><div class="label">Average</div><div class="value">${round1(data.summary.average).toFixed(1)}</div></div>
    <div class="kpi"><div class="label">Grade</div><div class="value grade-${data.summary.averageGrade}">${data.summary.averageGrade}</div></div>
    <div class="kpi"><div class="label">Trend</div><div class="value">${sparkSvg}</div></div>
  </section>

`;

  const gradeRows = GRADES.map((g) => {
    const count = data.summary.distribution[g];
    const pct = data.total === 0 ? 0 : (count / data.total) * 100;
    return `      <tr><td class="grade-${g}">${g}</td><td class="num">${count}</td><td class="num">${round1(pct).toFixed(1)}%</td></tr>`;
  }).join("\n");

  const distributionTable = `  <h2>Grade distribution</h2>
  <table>
    <thead><tr><th>Grade</th><th class="num">Count</th><th class="num">%</th></tr></thead>
    <tbody>
${gradeRows}
    </tbody>
  </table>

`;

  let authorSection = "";
  if (authors.length > 0) {
    const authorRows = authors
      .map(
        (a) =>
          `      <tr><td>${escapeHtml(a.author)}</td><td class="num">${a.total}</td><td class="num">${round1(a.average).toFixed(1)}</td><td class="grade-${a.averageGrade}">${a.averageGrade}</td><td class="num">${a.distribution.A}</td><td class="num">${a.distribution.B}</td><td class="num">${a.distribution.C}</td><td class="num">${a.distribution.D}</td><td class="num">${a.distribution.F}</td></tr>`
      )
      .join("\n");
    authorSection = `  <h2>By author</h2>
  <table>
    <thead><tr><th>Author</th><th class="num">Commits</th><th class="num">Avg</th><th>Grade</th><th class="num">A</th><th class="num">B</th><th class="num">C</th><th class="num">D</th><th class="num">F</th></tr></thead>
    <tbody>
${authorRows}
    </tbody>
  </table>

`;
  }

  let lowlightSection = "";
  if (data.lowlights.length > 0) {
    const persona = data.persona
      ? ` <span class="meta">Roasted by <strong>${escapeHtml(data.persona)}</strong>.</span>`
      : "";
    const items = data.lowlights
      .map((l) => {
        const subject = escapeHtml(l.commit.subject || "(empty subject)");
        const author = escapeHtml(l.commit.author || "unknown");
        const date = l.commit.date ? ` · ${escapeHtml(l.commit.date)}` : "";
        return `  <article class="lowlight">
    <h3><span class="grade-${l.grade}">${l.grade}</span> <span class="meta">(${l.score})</span> · <code>${escapeHtml(l.commit.shortSha)}</code> — ${subject}</h3>
    <div class="meta">${author}${date}</div>
    <blockquote>${escapeHtml(l.roast)}</blockquote>
  </article>`;
      })
      .join("\n");
    lowlightSection = `  <h2>Lowlights${persona}</h2>
${items}

`;
  }

  return `${head}${kpis}${distributionTable}${authorSection}${lowlightSection}${footer}`;
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Minimal Markdown escaping for user-supplied strings that we drop into
 * cells, headings, and blockquotes. Prevents accidental tables from author
 * names and stops backticks in commit subjects from breaking the row.
 */
export function escapeMd(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}

/**
 * HTML entity escaping — used for every user-controlled string that lands in
 * an attribute or text node. No `innerHTML` shortcuts anywhere.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
