import { simpleGit, type SimpleGit } from "simple-git";
import type { Commit } from "./git.js";
import { gradeCommit, type Grade } from "./grader.js";
import { scoreToGrade } from "./stats.js";
import type { RoastedCommit } from "./bin.js";
import { roastCommit, resolveConfigFromEnv, type RoastResult } from "./roaster.js";
import { loadPersona } from "./personaLoader.js";
import { render } from "./render.js";
import { getCommitDiff } from "./git.js";

/**
 * Minimum poll interval (ms). Anything below this is clamped so a runaway
 * `--interval 0` can't peg CPU or hammer the git process.
 */
export const MIN_INTERVAL_MS = 250;
/** Default poll interval when the user doesn't pass `--interval`. */
export const DEFAULT_INTERVAL_MS = 2000;

export interface WatchDeps {
  /** Return the current HEAD sha for `branch`, or null if unknown. */
  getHeadSha(branch?: string): Promise<string | null>;
  /** Fetch a single commit by sha. Returns null if not found. */
  getCommitBySha(sha: string): Promise<Commit | null>;
  /** Turn a raw commit into a full roasted commit (grade + roast + diff). */
  roastOne(commit: Commit): Promise<RoastedCommit>;
}

export interface SessionSummary {
  /** Number of new commits observed and roasted this session. */
  count: number;
  /** Rounded average score across observed commits (0..100). NaN → 0. */
  averageScore: number;
  /** Letter grade for `averageScore`, or "F" when count is 0. */
  averageGrade: Grade;
}

/**
 * Stateful helper for the `watch` command. Tracks which SHAs have already
 * been roasted this session so we never double-roast the same commit even
 * if the poller fires faster than git updates.
 *
 * Exposed as a class so tests can drive it deterministically without
 * spinning a real timer or a real git repo.
 */
export class WatchSession {
  private readonly seen = new Set<string>();
  private readonly scores: number[] = [];

  constructor(private readonly deps: WatchDeps) {}

  /**
   * Poll once. If HEAD points at a new sha we haven't roasted yet, load and
   * roast it. Returns the RoastedCommit for the caller to render, or null
   * when nothing new (or nothing loadable) is available.
   */
  async tick(branch?: string): Promise<RoastedCommit | null> {
    const sha = await this.deps.getHeadSha(branch);
    if (!sha) return null;
    if (this.seen.has(sha)) return null;
    this.seen.add(sha);
    const commit = await this.deps.getCommitBySha(sha);
    if (!commit) return null;
    const roasted = await this.deps.roastOne(commit);
    this.scores.push(roasted.grade.score);
    return roasted;
  }

  /**
   * Mark a sha as already-seen without roasting it. Used at startup so the
   * current HEAD isn't roasted retroactively — we only roast *new* commits
   * that land after `watch` starts.
   */
  markSeen(sha: string | null | undefined): void {
    if (sha) this.seen.add(sha);
  }

  /** How many distinct SHAs we've observed (including markSeen'd ones). */
  seenCount(): number {
    return this.seen.size;
  }

  summary(): SessionSummary {
    const count = this.scores.length;
    if (count === 0) return { count: 0, averageScore: 0, averageGrade: "F" };
    const avg = this.scores.reduce((a, b) => a + b, 0) / count;
    return {
      count,
      averageScore: Math.round(avg),
      averageGrade: scoreToGrade(avg),
    };
  }
}

/** Format the one-line summary printed on Ctrl-C. */
export function formatSessionSummary(s: SessionSummary): string {
  return `Watched ${s.count} commit${s.count === 1 ? "" : "s"} • avg grade ${s.averageGrade}`;
}

/** Clamp a user-provided interval to something sane. */
export function normalizeInterval(input: unknown): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(n));
}

export interface WatchCliOptions {
  branch?: string;
  persona?: string;
  interval?: string | number;
  json?: boolean;
  diff?: boolean;
  diffBytes?: number;
  color?: boolean;
}

/**
 * Build a WatchDeps backed by the real git repo + roast pipeline. Split out
 * so tests can substitute deterministic implementations without patching
 * modules.
 */
export function buildDefaultDeps(args: {
  personaName: string;
  wantDiff: boolean;
  diffBytes?: number;
  git?: SimpleGit;
}): WatchDeps {
  const g = args.git ?? simpleGit();
  return {
    async getHeadSha(branch?: string): Promise<string | null> {
      const ref = branch ? `refs/heads/${branch}` : "HEAD";
      try {
        const sha = (await g.raw(["rev-parse", ref])).trim();
        return sha || null;
      } catch {
        return null;
      }
    },
    async getCommitBySha(sha: string): Promise<Commit | null> {
      const FIELD = "\x1f";
      const format = ["%H", "%h", "%s", "%b", "%an", "%aI"].join(FIELD);
      try {
        const raw = await g.raw([
          "log",
          "-n",
          "1",
          `--pretty=format:${format}`,
          sha,
        ]);
        if (!raw.trim()) return null;
        const [full, short, subject, body, author, date] = raw.split(FIELD);
        return {
          sha: full ?? sha,
          shortSha: short ?? sha.slice(0, 7),
          subject: subject ?? "",
          body: (body ?? "").trim(),
          author: author ?? "",
          date: date ?? "",
        };
      } catch {
        return null;
      }
    },
    async roastOne(commit: Commit): Promise<RoastedCommit> {
      const grade = gradeCommit(commit);
      const persona = await loadPersona(args.personaName);
      const cfg = resolveConfigFromEnv(process.env, {});
      const diff = args.wantDiff
        ? await getCommitDiff(
            commit.sha,
            args.diffBytes !== undefined ? { maxBytes: args.diffBytes } : {}
          ).catch(() => undefined)
        : undefined;
      let roast: RoastResult;
      try {
        roast = await roastCommit(commit, persona, grade.grade, cfg, diff ? { diff } : {});
      } catch {
        // Never let a roast failure kill the watch loop; fall back to offline.
        roast = { roast: grade.roast, rewrite: commit.subject, source: "fallback" };
      }
      return { commit, grade, roast, diff };
    },
  };
}

/**
 * Entry point for `commit-roast watch`. Polls HEAD and prints a roast block
 * per new commit until SIGINT. Prints the session summary on exit.
 *
 * Kept short and mostly plumbing so the interesting logic (dedup, summary)
 * lives on WatchSession and can be tested in isolation.
 */
export async function runWatch(opts: WatchCliOptions = {}): Promise<void> {
  const personaName = opts.persona ?? "linus";
  const intervalMs = normalizeInterval(opts.interval);
  const deps = buildDefaultDeps({
    personaName,
    wantDiff: Boolean(opts.diff),
    diffBytes: opts.diffBytes,
  });
  const session = new WatchSession(deps);
  const initialSha = await deps.getHeadSha(opts.branch);
  session.markSeen(initialSha);

  if (!opts.json) {
    const branchLabel = opts.branch ?? "HEAD";
    process.stderr.write(
      `commit-roast watch: polling ${branchLabel} every ${intervalMs}ms (Ctrl-C to stop)\n`
    );
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const summary = session.summary();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ summary }) + "\n");
    } else {
      process.stdout.write("\n" + formatSessionSummary(summary) + "\n");
    }
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Fire-and-poll loop. setTimeout > setInterval so a slow tick doesn't stack.
  while (!stopped) {
    try {
      const roasted = await session.tick(opts.branch);
      if (roasted) {
        const rendered = render([roasted], {
          persona: personaName,
          mode: opts.json ? "json" : "pretty",
          color: opts.color,
        });
        process.stdout.write(rendered + "\n");
      }
    } catch (err) {
      process.stderr.write(
        `commit-roast watch: tick failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
