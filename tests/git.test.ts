import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { getCommitDiff, getRecentCommits } from "../src/git.js";

describe("git.getCommitDiff", () => {
  let dir: string;
  let g: SimpleGit;
  let shaCode = "";
  let shaLock = "";
  let shaBig = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "commit-roast-diff-"));
    g = simpleGit(dir);
    await g.init();
    await g.addConfig("user.email", "test@example.com");
    await g.addConfig("user.name", "Test");

    writeFileSync(join(dir, "a.txt"), "hello world\n");
    await g.add("a.txt");
    await g.commit("feat: add a");
    shaCode = (await g.revparse(["HEAD"])).trim();

    writeFileSync(join(dir, "package-lock.json"), "{\n  \"name\": \"x\"\n}\n");
    await g.add("package-lock.json");
    await g.commit("chore: lockfile");
    shaLock = (await g.revparse(["HEAD"])).trim();

    // A file big enough to force truncation under a small budget.
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(join(dir, "big.txt"), big);
    await g.add("big.txt");
    await g.commit("feat: add big file");
    shaBig = (await g.revparse(["HEAD"])).trim();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a diff for a normal code commit", async () => {
    const d = await getCommitDiff(shaCode, { cwd: dir });
    expect(d.diff).toContain("diff --git a/a.txt b/a.txt");
    expect(d.diff).toContain("+hello world");
    expect(d.truncated).toBe(false);
    expect(d.bytes).toBe(Buffer.byteLength(d.diff, "utf8"));
    expect(d.skipped).toEqual([]);
  });

  it("skips lockfile-heavy paths and lists them in skipped", async () => {
    const d = await getCommitDiff(shaLock, { cwd: dir });
    expect(d.diff).toBe("");
    expect(d.skipped).toContain("package-lock.json");
  });

  it("truncates cleanly at file boundaries with a marker", async () => {
    const d = await getCommitDiff(shaBig, { cwd: dir, maxBytes: 256 });
    expect(d.truncated).toBe(true);
    expect(d.diff.endsWith("… (truncated)\n") || d.diff.includes("… (truncated)")).toBe(true);
    expect(d.bytes).toBeLessThanOrEqual(256);
  });
});

describe("git.getRecentCommits filters", () => {
  let dir: string;
  let g: SimpleGit;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "commit-roast-log-"));
    g = simpleGit(dir);
    await g.init();
    await g.addConfig("user.email", "alice@example.com");
    await g.addConfig("user.name", "Alice");

    // Helper: commit with a backdated author *and* committer date so
    // `git log --since` / `--until` (committer date by default) both agree.
    async function commitAt(subject: string, isoDate: string, envAuthor: {name: string, email: string}) {
      await g.env({
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_DATE: isoDate,
        GIT_AUTHOR_NAME: envAuthor.name,
        GIT_AUTHOR_EMAIL: envAuthor.email,
        GIT_COMMITTER_NAME: envAuthor.name,
        GIT_COMMITTER_EMAIL: envAuthor.email,
        PATH: process.env.PATH ?? "",
      }).raw(["commit", "-m", subject, "--date", isoDate]);
    }

    writeFileSync(join(dir, "a.txt"), "a\n");
    await g.add("a.txt");
    await commitAt("feat: alice one", "2026-01-01T00:00:00Z", { name: "Alice", email: "alice@example.com" });

    writeFileSync(join(dir, "b.txt"), "b\n");
    await g.add("b.txt");
    await commitAt("feat: bob one", "2026-01-15T00:00:00Z", { name: "Bob", email: "bob@example.com" });

    writeFileSync(join(dir, "c.txt"), "c\n");
    await g.add("c.txt");
    await commitAt("feat: alice two", "2026-02-01T00:00:00Z", { name: "Alice", email: "alice@example.com" });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters by author (name)", async () => {
    const commits = await getRecentCommits({ cwd: dir, count: 50, author: "Alice" });
    expect(commits.map((c) => c.subject)).toEqual(["feat: alice two", "feat: alice one"]);
  });

  it("treats date-shaped --since as --since=<date>", async () => {
    const commits = await getRecentCommits({ cwd: dir, count: 50, since: "2026-01-10" });
    // Only commits authored on/after 2026-01-10 should survive.
    expect(commits.map((c) => c.subject)).toEqual(["feat: alice two", "feat: bob one"]);
  });

  it("treats date-shaped --until as --until=<date>", async () => {
    const commits = await getRecentCommits({ cwd: dir, count: 50, until: "2026-01-20" });
    // Everything on/before 2026-01-20 should survive.
    expect(commits.map((c) => c.subject)).toEqual(["feat: bob one", "feat: alice one"]);
  });

  it("combines since+until+author", async () => {
    const commits = await getRecentCommits({
      cwd: dir,
      count: 50,
      since: "2025-12-31",
      until: "2026-01-20",
      author: "Alice",
    });
    expect(commits.map((c) => c.subject)).toEqual(["feat: alice one"]);
  });
});
