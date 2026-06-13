import { simpleGit, type SimpleGit } from "simple-git";

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
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
