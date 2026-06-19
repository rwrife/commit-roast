import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Commit } from "./git.js";
import { gradeCommit, type GradeResult } from "./grader.js";
import { loadPersona, type Persona } from "./personaLoader.js";
import { roastCommit, resolveConfigFromEnv, type RoasterConfig, type RoastResult } from "./roaster.js";
import { scoreToGrade } from "./stats.js";

const execFileP = promisify(execFile);

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parse a GitHub PR URL or shorthand into {owner, repo, number}.
 * Accepted forms:
 *   - https://github.com/owner/repo/pull/123
 *   - http://github.com/owner/repo/pull/123/files
 *   - owner/repo#123
 *   - owner/repo/123
 */
export function parsePrUrl(input: string): PrRef {
  const trimmed = input.trim();
  // Full URL
  const urlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i
  );
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: Number(urlMatch[3]) };
  }
  // owner/repo#123
  const shortHash = trimmed.match(/^([^/\s]+)\/([^/#\s]+)#(\d+)$/);
  if (shortHash) {
    return { owner: shortHash[1], repo: shortHash[2], number: Number(shortHash[3]) };
  }
  // owner/repo/123
  const shortSlash = trimmed.match(/^([^/\s]+)\/([^/\s]+)\/(\d+)$/);
  if (shortSlash) {
    return { owner: shortSlash[1], repo: shortSlash[2], number: Number(shortSlash[3]) };
  }
  throw new Error(
    `Could not parse PR reference: ${input}. Expected a github.com PR URL or owner/repo#NUM.`
  );
}

/** Loose JSON shape returned by `gh api .../pulls/N/commits`. */
interface GhCommit {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
  };
  author?: { login?: string } | null;
}

export interface GhRunner {
  (args: string[]): Promise<string>;
}

/** Default runner: shells out to the user's `gh` CLI for auth + transport. */
export const defaultGhRunner: GhRunner = async (args) => {
  const { stdout } = await execFileP("gh", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};

/** Fetch commits on a PR via the GitHub API (paginated). */
export async function fetchPrCommits(
  ref: PrRef,
  runner: GhRunner = defaultGhRunner
): Promise<Commit[]> {
  const path = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits`;
  // --paginate handles >100 commit PRs; --per_page maxes the page size.
  const raw = await runner(["api", "--paginate", "-X", "GET", "-F", "per_page=100", path]);
  // `gh api --paginate` concatenates JSON arrays back-to-back like "][" — normalize.
  const normalized = raw.replace(/\]\s*\[/g, ",");
  const arr = JSON.parse(normalized) as GhCommit[];
  return arr.map((c) => {
    const message = c.commit.message ?? "";
    const nl = message.indexOf("\n");
    const subject = nl === -1 ? message : message.slice(0, nl);
    const body = nl === -1 ? "" : message.slice(nl + 1).trim();
    const sha = c.sha ?? "";
    return {
      sha,
      shortSha: sha.slice(0, 7),
      subject: subject.trim(),
      body,
      author: c.author?.login ?? c.commit.author?.name ?? "",
      date: c.commit.author?.date ?? "",
    };
  });
}

export interface TeamRoastItem {
  commit: Commit;
  grade: GradeResult;
  roast: RoastResult;
}

export interface TeamRoastResult {
  ref: PrRef;
  persona: string;
  items: TeamRoastItem[];
  averageScore: number;
  averageGrade: string;
}

export interface BuildTeamRoastOptions {
  ref: PrRef;
  personaName?: string;
  runner?: GhRunner;
  config?: RoasterConfig;
  /** For tests: override persona loader. */
  loadPersonaImpl?: (name: string) => Promise<Persona>;
}

export async function buildTeamRoast(opts: BuildTeamRoastOptions): Promise<TeamRoastResult> {
  const personaName = (opts.personaName ?? "linus").toLowerCase();
  const persona = await (opts.loadPersonaImpl ?? loadPersona)(personaName);
  const cfg = opts.config ?? resolveConfigFromEnv();
  const commits = await fetchPrCommits(opts.ref, opts.runner);
  const items: TeamRoastItem[] = [];
  let total = 0;
  for (const c of commits) {
    const grade = gradeCommit(c);
    const roast = await roastCommit(c, persona, grade.grade, cfg);
    items.push({ commit: c, grade, roast });
    total += grade.score;
  }
  const avg = items.length ? total / items.length : 0;
  return {
    ref: opts.ref,
    persona: persona.name,
    items,
    averageScore: Math.round(avg),
    averageGrade: scoreToGrade(avg),
  };
}

const PERSONA_EMOJI: Record<string, string> = {
  linus: "🐧",
  pm: "📋",
  bard: "🎭",
  teacher: "📚",
};

/** Render the rolled-up GitHub PR comment in Markdown. */
export function formatTeamComment(result: TeamRoastResult): string {
  const emoji = PERSONA_EMOJI[result.persona] ?? "🔥";
  const heading = `## ${emoji} commit-roast — \`${result.persona}\` mode`;
  if (result.items.length === 0) {
    return `${heading}\n\nNo commits to roast on this PR. Suspicious.\n`;
  }
  const summary =
    `**${result.items.length}** commit${result.items.length === 1 ? "" : "s"}` +
    ` scored. Average **${result.averageScore}/100 (${result.averageGrade})**.`;
  const rows = result.items.map(({ commit, grade, roast }) => {
    const subject = escapeCell(commit.subject || "(empty subject)");
    const rewrite = escapeCell(roast.rewrite);
    const sha = commit.shortSha || commit.sha.slice(0, 7);
    return `| \`${sha}\` | **${grade.grade}** | ${subject} | ${escapeCell(roast.roast)} | ${rewrite} |`;
  });
  const table = [
    "| sha | grade | subject | roast | suggested rewrite |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  const footer =
    "\n<sub>Posted by [commit-roast](https://github.com/rwrife/commit-roast). " +
    "Roasts are jokes; rewrites are suggestions.</sub>\n";
  return [heading, "", summary, "", table, footer].join("\n");
}

function escapeCell(s: string): string {
  // Markdown table cells: escape pipes and collapse newlines.
  return s.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
}

export interface PostTeamCommentOptions {
  ref: PrRef;
  body: string;
  runner?: GhRunner;
}

/**
 * POST a comment to the PR's underlying issue.
 * Returns the html_url of the created comment when available.
 */
export async function postTeamComment(opts: PostTeamCommentOptions): Promise<string | null> {
  const runner = opts.runner ?? defaultGhRunner;
  const path = `repos/${opts.ref.owner}/${opts.ref.repo}/issues/${opts.ref.number}/comments`;
  const stdout = await runner([
    "api",
    "-X",
    "POST",
    path,
    "-f",
    `body=${opts.body}`,
  ]);
  try {
    const parsed = JSON.parse(stdout) as { html_url?: string };
    return parsed.html_url ?? null;
  } catch {
    return null;
  }
}
