import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  buildRewritePlan,
  buildRebaseExecScript,
  shellQuote,
  assertCleanWorkingTree,
  renderRewritePlan,
} from "../src/rewrite.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "commit-roast-rewrite-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // Make sure no global hooks / signing kicks in.
  execSync("git config commit.gpgsign false", { cwd: dir });
  return dir;
}

function commit(dir: string, file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  execSync(`git add ${file}`, { cwd: dir });
  execSync(`git commit -q -m ${JSON.stringify(msg)}`, { cwd: dir });
}

describe("shellQuote", () => {
  it("wraps plain strings in single quotes", () => {
    expect(shellQuote("hello")).toBe(`'hello'`);
  });
  it("escapes embedded single quotes safely", () => {
    expect(shellQuote("it's fine")).toBe(`'it'\\''s fine'`);
  });
});

describe("buildRebaseExecScript", () => {
  it("references the target sha and quotes the new subject", () => {
    const out = buildRebaseExecScript("abcdef1234567890", "fix: stop crashing");
    expect(out).toContain("abcdef1234567890");
    expect(out).toContain(`'fix: stop crashing'`);
    expect(out).toContain("git rebase --exec");
    expect(out).toContain("abcdef1234567890~1");
  });
});

describe("renderRewritePlan", () => {
  it("includes the command and a force-with-lease warning", () => {
    const txt = renderRewritePlan({
      mode: "amend",
      sha: "a".repeat(40),
      shortSha: "aaaaaaa",
      originalSubject: "stuff",
      rewrite: "chore: stuff",
      roast: "meh",
      command: "git commit --amend -m 'chore: stuff'",
    });
    expect(txt).toContain("chore: stuff");
    expect(txt).toContain("git commit --amend");
    expect(txt).toContain("--force-with-lease");
  });
});

describe("assertCleanWorkingTree", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
    commit(dir, "a.txt", "1", "initial");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes on a clean tree", async () => {
    await expect(assertCleanWorkingTree(simpleGit(dir), false)).resolves.toBeUndefined();
  });

  it("throws on a dirty tree without force", async () => {
    writeFileSync(join(dir, "a.txt"), "2");
    await expect(assertCleanWorkingTree(simpleGit(dir), false)).rejects.toThrow(/dirty/);
  });

  it("allows a dirty tree when force=true", async () => {
    writeFileSync(join(dir, "a.txt"), "2");
    await expect(assertCleanWorkingTree(simpleGit(dir), true)).resolves.toBeUndefined();
  });
});

describe("buildRewritePlan", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns mode=amend when sha is HEAD", async () => {
    commit(dir, "a.txt", "1", "added stuff");
    const plan = await buildRewritePlan({ sha: "HEAD", cwd: dir });
    expect(plan.mode).toBe("amend");
    expect(plan.originalSubject).toBe("added stuff");
    expect(plan.command).toMatch(/^git commit --amend -m /);
    // Fallback roast produces a conventional-commits subject.
    expect(plan.rewrite).toMatch(/^(chore|feat|fix|docs|style|refactor|perf|test|build|ci|revert)/);
  });

  it("returns mode=rebase for older commits", async () => {
    commit(dir, "a.txt", "1", "first commit");
    commit(dir, "b.txt", "2", "second commit");
    const firstSha = execSync("git rev-parse HEAD~1", { cwd: dir }).toString().trim();
    const plan = await buildRewritePlan({ sha: firstSha, cwd: dir });
    expect(plan.mode).toBe("rebase");
    expect(plan.sha).toBe(firstSha);
    expect(plan.command).toContain("git rebase --exec");
    expect(plan.command).toContain(firstSha);
  });

  it("refuses on a dirty working tree without force", async () => {
    commit(dir, "a.txt", "1", "initial");
    writeFileSync(join(dir, "a.txt"), "2");
    await expect(buildRewritePlan({ sha: "HEAD", cwd: dir })).rejects.toThrow(/dirty/);
  });

  it("proceeds on a dirty tree when force=true", async () => {
    commit(dir, "a.txt", "1", "initial");
    writeFileSync(join(dir, "a.txt"), "2");
    const plan = await buildRewritePlan({ sha: "HEAD", cwd: dir, force: true });
    expect(plan.mode).toBe("amend");
  });
});
