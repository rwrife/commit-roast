import { simpleGit, type SimpleGit } from "simple-git";

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
}

export interface GetCommitDiffOptions {
  /** Soft cap on total diff bytes returned. Defaults to ~4KB. */
  maxBytes?: number;
  cwd?: string;
  git?: SimpleGit;
}

export interface CommitDiff {
  /** The (possibly truncated) unified diff. Empty when nothing usable remained. */
  diff: string;
  /** Byte length of `diff` (UTF-8). */
  bytes: number;
  /** True when one or more file diffs were dropped to stay under the cap. */
  truncated: boolean;
  /** Paths skipped because they were binary or lockfile-heavy. */
  skipped: string[];
}

const DEFAULT_DIFF_BYTES = 4096;

// Lockfile-heavy / generated paths. Diffs here are huge and not useful
// signal for a roaster grading the *human* part of a commit.
const LOCKFILE_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)Cargo\.lock$/i,
  /(^|\/)Gemfile\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)go\.sum$/i,
  /\.lock$/i,
];

function parseDiffHeaderPaths(header: string): string[] {
  // `diff --git a/foo b/foo` → ["foo"]. Handles renames roughly.
  const m = header.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
  if (!m) return [];
  return [m[1], m[2]].filter((p, i, arr) => arr.indexOf(p) === i);
}

function isBinaryChunk(chunk: string): boolean {
  return /\nBinary files .* differ\n/.test(chunk) || /\nGIT binary patch\n/.test(chunk);
}

function isLockfilePath(path: string): boolean {
  return LOCKFILE_PATTERNS.some((r) => r.test(path));
}

/**
 * Read the unified diff for a single commit, with binary/lockfile chunks
 * stripped and a soft byte cap applied at file boundaries.
 *
 * We split on `diff --git ` so truncation never cuts a hunk in half — easier
 * for an LLM to make sense of and harder to mislead it with a half-line.
 */
export async function getCommitDiff(
  sha: string,
  opts: GetCommitDiffOptions = {}
): Promise<CommitDiff> {
  const { maxBytes = DEFAULT_DIFF_BYTES, cwd, git } = opts;
  const g = git ?? simpleGit(cwd);

  // --no-color so we don't leak ANSI into the prompt; -m so merges produce a
  // diff against the first parent instead of nothing.
  const raw = await g.raw([
    "show",
    "--no-color",
    "-m",
    "--first-parent",
    "--format=",
    sha,
  ]);

  if (!raw.trim()) {
    return { diff: "", bytes: 0, truncated: false, skipped: [] };
  }

  // Split into per-file chunks. The first split entry is whatever precedes
  // the first `diff --git ` (usually empty); discard it.
  const parts = raw.split(/^diff --git /m);
  const chunks = parts.slice(1).map((p) => `diff --git ${p}`);

  const skipped: string[] = [];
  const kept: string[] = [];
  let truncated = false;
  let runningBytes = 0;
  const truncMarker = "… (truncated)\n";
  const truncBytes = Buffer.byteLength(truncMarker, "utf8");

  for (const chunk of chunks) {
    const paths = parseDiffHeaderPaths(chunk);
    const primary = paths[0] ?? "(unknown)";

    if (isBinaryChunk(chunk)) {
      skipped.push(primary);
      continue;
    }
    if (paths.some(isLockfilePath)) {
      skipped.push(primary);
      continue;
    }

    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    // Make sure we can fit this chunk *and* still afford the truncation
    // marker if a later chunk has to be dropped.
    if (runningBytes + chunkBytes > maxBytes - truncBytes && kept.length > 0) {
      truncated = true;
      break;
    }
    // First chunk alone larger than the budget: keep what fits and bail.
    if (kept.length === 0 && chunkBytes > maxBytes - truncBytes) {
      const slice = Buffer.from(chunk, "utf8")
        .subarray(0, Math.max(0, maxBytes - truncBytes))
        .toString("utf8");
      kept.push(slice);
      runningBytes += Buffer.byteLength(slice, "utf8");
      truncated = true;
      break;
    }
    kept.push(chunk);
    runningBytes += chunkBytes;
  }

  let body = kept.join("");
  if (truncated) body += truncMarker;

  return {
    diff: body,
    bytes: Buffer.byteLength(body, "utf8"),
    truncated,
    skipped,
  };
}

export interface GetRecentCommitsOptions {
  count?: number;
  since?: string;
  cwd?: string;
  git?: SimpleGit;
}

/**
 * Read recent commits from the current git repo.
 * Returns newest-first. `since` is any ref/sha understood by `git log`.
 */
export async function getRecentCommits(
  opts: GetRecentCommitsOptions = {}
): Promise<Commit[]> {
  const { count = 5, since, cwd, git } = opts;
  const g = git ?? simpleGit(cwd);

  // Use a delimiter unlikely to appear in commit messages.
  const FIELD = "\x1f";
  const RECORD = "\x1e";
  const format = ["%H", "%h", "%s", "%b", "%an", "%aI"].join(FIELD) + RECORD;

  const args = ["log", `--pretty=format:${format}`, `-n`, String(count)];
  if (since) args.push(`${since}..HEAD`);

  const raw = await g.raw(args);
  if (!raw.trim()) return [];

  return raw
    .split(RECORD)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.length > 0)
    .map((record) => {
      const [sha, shortSha, subject, body, author, date] = record.split(FIELD);
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        subject: subject ?? "",
        body: (body ?? "").trim(),
        author: author ?? "",
        date: date ?? "",
      };
    });
}
