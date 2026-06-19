import type { Commit } from "./git.js";
import { gradeCommit, type Grade, type GradeResult } from "./grader.js";

export interface GradedCommit {
  commit: Commit;
  grade: GradeResult;
}

export interface StatsSummary {
  total: number;
  average: number; // mean numeric score (0..100)
  averageGrade: Grade;
  distribution: Record<Grade, number>;
  sparkline: string;
  best: GradedCommit | null;
  worst: GradedCommit | null;
  byAuthor: Record<string, AuthorStats>;
}

export interface AuthorStats {
  author: string;
  total: number;
  average: number;
  averageGrade: Grade;
  distribution: Record<Grade, number>;
}

const GRADES: Grade[] = ["A", "B", "C", "D", "F"];

// 8 levels — Unicode block characters used by basically every "sparkline" tool.
const SPARK_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function gradeAll(commits: Commit[]): GradedCommit[] {
  return commits.map((commit) => ({ commit, grade: gradeCommit(commit) }));
}

/** Map a numeric 0..100 score back to a letter grade matching grader.ts thresholds. */
export function scoreToGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function emptyDistribution(): Record<Grade, number> {
  return { A: 0, B: 0, C: 0, D: 0, F: 0 };
}

/**
 * Build a unicode sparkline from numeric scores. Returns "" for an empty list.
 * Scale is fixed 0..100 so multiple sparklines are visually comparable.
 */
export function sparkline(scores: number[]): string {
  if (scores.length === 0) return "";
  return scores
    .map((s) => {
      const clamped = Math.max(0, Math.min(100, s));
      // 8 buckets: 0-12.5, 12.5-25, ..., 87.5-100
      const idx = Math.min(SPARK_BARS.length - 1, Math.floor(clamped / (100 / SPARK_BARS.length)));
      return SPARK_BARS[idx];
    })
    .join("");
}

/**
 * Summarize a list of graded commits. Commits are expected oldest-last (i.e.
 * the standard `git log` order), but we render the sparkline oldest→newest so
 * "trend" reads left-to-right like a normal chart.
 */
export function summarize(graded: GradedCommit[]): StatsSummary {
  const distribution = emptyDistribution();
  const byAuthor: Record<string, AuthorStats> = {};
  let scoreSum = 0;
  let best: GradedCommit | null = null;
  let worst: GradedCommit | null = null;

  for (const g of graded) {
    distribution[g.grade.grade]++;
    scoreSum += g.grade.score;
    if (!best || g.grade.score > best.grade.score) best = g;
    if (!worst || g.grade.score < worst.grade.score) worst = g;

    const author = g.commit.author || "unknown";
    if (!byAuthor[author]) {
      byAuthor[author] = {
        author,
        total: 0,
        average: 0,
        averageGrade: "F",
        distribution: emptyDistribution(),
      };
    }
    byAuthor[author].total++;
    byAuthor[author].distribution[g.grade.grade]++;
    byAuthor[author].average += g.grade.score;
  }

  for (const a of Object.values(byAuthor)) {
    a.average = a.total > 0 ? a.average / a.total : 0;
    a.averageGrade = scoreToGrade(a.average);
  }

  const total = graded.length;
  const average = total > 0 ? scoreSum / total : 0;
  // Sparkline reads oldest→newest. `git log` is newest-first, so reverse.
  const scoresOldestFirst = graded.slice().reverse().map((g) => g.grade.score);
  return {
    total,
    average,
    averageGrade: scoreToGrade(average),
    distribution,
    sparkline: sparkline(scoresOldestFirst),
    best,
    worst,
    byAuthor,
  };
}

export interface RenderStatsOptions {
  mode?: "pretty" | "json";
}

export function renderStats(summary: StatsSummary, opts: RenderStatsOptions = {}): string {
  if (opts.mode === "json") {
    return JSON.stringify(
      {
        total: summary.total,
        average: round1(summary.average),
        averageGrade: summary.averageGrade,
        distribution: summary.distribution,
        sparkline: summary.sparkline,
        best: summary.best ? gradedToJson(summary.best) : null,
        worst: summary.worst ? gradedToJson(summary.worst) : null,
        byAuthor: Object.values(summary.byAuthor).map((a) => ({
          author: a.author,
          total: a.total,
          average: round1(a.average),
          averageGrade: a.averageGrade,
          distribution: a.distribution,
        })),
      },
      null,
      2
    );
  }
  return renderPretty(summary);
}

function gradedToJson(g: GradedCommit) {
  return {
    sha: g.commit.sha,
    shortSha: g.commit.shortSha,
    subject: g.commit.subject,
    author: g.commit.author,
    date: g.commit.date,
    grade: g.grade.grade,
    score: g.grade.score,
    reasons: g.grade.reasons,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function renderPretty(s: StatsSummary): string {
  if (s.total === 0) {
    return "No commits to score. Either you're between commits or this isn't a git repo.";
  }
  const lines: string[] = [];
  lines.push(`Commits scored: ${s.total}`);
  lines.push(
    `Average: ${round1(s.average).toFixed(1)} (${s.averageGrade})  Trend: ${s.sparkline}`
  );
  const dist = GRADES.map((g) => `${g}:${s.distribution[g]}`).join("  ");
  lines.push(`Distribution: ${dist}`);

  if (s.best && s.worst && s.best.commit.sha !== s.worst.commit.sha) {
    lines.push("");
    lines.push(`Best  ${s.best.grade.grade} (${s.best.grade.score})  ${s.best.commit.shortSha}  ${s.best.commit.subject}`);
    lines.push(`Worst ${s.worst.grade.grade} (${s.worst.grade.score})  ${s.worst.commit.shortSha}  ${s.worst.commit.subject}`);
  } else if (s.best) {
    lines.push("");
    lines.push(`Sole entrant ${s.best.grade.grade} (${s.best.grade.score})  ${s.best.commit.shortSha}  ${s.best.commit.subject}`);
  }

  const authors = Object.values(s.byAuthor);
  if (authors.length > 1) {
    lines.push("");
    lines.push("By author:");
    for (const a of authors.sort((x, y) => y.average - x.average)) {
      lines.push(
        `  ${a.author.padEnd(20)} ${a.averageGrade}  avg ${round1(a.average).toFixed(1).padStart(5)}  n=${a.total}`
      );
    }
  }

  return lines.join("\n");
}
