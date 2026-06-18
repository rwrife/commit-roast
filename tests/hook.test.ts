import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  installHook,
  uninstallHook,
  hookStatus,
  runHook,
  splitMessage,
  resolveHooksDir,
} from "../src/hook.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commit-roast-hook-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

describe("hook installer", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("resolves the default hooks dir to <gitdir>/hooks", async () => {
    const dir = await resolveHooksDir(repo);
    expect(dir).toMatch(/\.git\/hooks$/);
  });

  it("respects core.hooksPath", async () => {
    git(repo, ["config", "core.hooksPath", ".githooks"]);
    const dir = await resolveHooksDir(repo);
    expect(dir).toBe(join(repo, ".githooks"));
  });

  it("installs a prepare-commit-msg hook with the marker and is executable", async () => {
    const result = await installHook({ cwd: repo });
    expect(result.type).toBe("prepare-commit-msg");
    expect(result.replaced).toBe(false);
    const contents = await readFile(result.path, "utf8");
    expect(contents).toContain("commit-roast: managed hook");
    expect(contents).toContain("exec commit-roast hook run --type prepare-commit-msg");
    const st = await stat(result.path);
    // owner exec bit
    expect(st.mode & 0o100).toBe(0o100);
  });

  it("refuses to overwrite a foreign hook without --force", async () => {
    const hooksDir = await resolveHooksDir(repo);
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "prepare-commit-msg");
    await writeFile(hookPath, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    await expect(installHook({ cwd: repo })).rejects.toThrow(/Refusing to overwrite/);
  });

  it("backs up a foreign hook when --force is used", async () => {
    const hooksDir = await resolveHooksDir(repo);
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "prepare-commit-msg");
    await writeFile(hookPath, "#!/bin/sh\necho original\n", { mode: 0o755 });
    const result = await installHook({ cwd: repo, force: true });
    expect(result.replaced).toBe(true);
    expect(result.backupPath).toBe(`${hookPath}.bak`);
    const backup = await readFile(result.backupPath!, "utf8");
    expect(backup).toContain("echo original");
  });

  it("overwrites a managed hook without backup", async () => {
    await installHook({ cwd: repo });
    const result = await installHook({ cwd: repo });
    expect(result.replaced).toBe(true);
    expect(result.backupPath).toBeUndefined();
  });

  it("uninstalls a managed hook and restores .bak", async () => {
    const hooksDir = await resolveHooksDir(repo);
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "prepare-commit-msg");
    await writeFile(hookPath, "#!/bin/sh\necho original\n", { mode: 0o755 });
    await installHook({ cwd: repo, force: true });
    const result = await uninstallHook({ cwd: repo });
    expect(result.removed).toBe(true);
    expect(result.restoredFrom).toBe(`${hookPath}.bak`);
    const restored = await readFile(hookPath, "utf8");
    expect(restored).toContain("echo original");
  });

  it("leaves foreign hooks alone on uninstall", async () => {
    const hooksDir = await resolveHooksDir(repo);
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "prepare-commit-msg");
    await writeFile(hookPath, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    const result = await uninstallHook({ cwd: repo });
    expect(result.removed).toBe(false);
    expect(result.note).toMatch(/not installed by commit-roast/);
    const contents = await readFile(hookPath, "utf8");
    expect(contents).toContain("echo foreign");
  });

  it("reports status for both supported hook types", async () => {
    await installHook({ cwd: repo, type: "commit-msg" });
    const rows = await hookStatus(repo);
    const prepare = rows.find((r) => r.type === "prepare-commit-msg")!;
    const commit = rows.find((r) => r.type === "commit-msg")!;
    expect(prepare.installed).toBe(false);
    expect(commit.installed).toBe(true);
    expect(commit.managedByCommitRoast).toBe(true);
  });
});

describe("splitMessage", () => {
  it("ignores git's comment lines and extracts subject + body", () => {
    const raw = [
      "feat: add roast hook",
      "",
      "Body line one.",
      "Body line two.",
      "",
      "# Please enter the commit message for your changes.",
      "# Lines starting with '#' will be ignored.",
    ].join("\n");
    expect(splitMessage(raw)).toEqual({
      subject: "feat: add roast hook",
      body: "Body line one.\nBody line two.",
    });
  });

  it("handles empty messages", () => {
    expect(splitMessage("# comment only\n")).toEqual({ subject: "", body: "" });
  });
});

describe("runHook", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "commit-roast-hook-run-"));
    file = join(dir, "COMMIT_EDITMSG");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("grades a real message and appends commented feedback for prepare-commit-msg", async () => {
    await writeFile(file, "wip\n", "utf8");
    const result = await runHook({ messageFile: file, type: "prepare-commit-msg" });
    expect(result.graded).toBe(true);
    expect(result.output[0]).toMatch(/grade F/);
    const after = await readFile(file, "utf8");
    expect(after).toContain("# commit-roast: grade F");
    expect(after.startsWith("wip")).toBe(true);
  });

  it("does not duplicate the commented block on re-invocation", async () => {
    await writeFile(file, "feat: do the thing\n", "utf8");
    await runHook({ messageFile: file, type: "prepare-commit-msg" });
    const once = await readFile(file, "utf8");
    await runHook({ messageFile: file, type: "prepare-commit-msg" });
    const twice = await readFile(file, "utf8");
    expect(twice).toBe(once);
  });

  it("skips merge/squash/commit sources for prepare-commit-msg", async () => {
    await writeFile(file, "Merge branch 'foo'\n", "utf8");
    const result = await runHook({
      messageFile: file,
      type: "prepare-commit-msg",
      source: "merge",
    });
    expect(result.graded).toBe(false);
    expect(result.skipped).toBe("source=merge");
  });

  it("skips empty subjects", async () => {
    await writeFile(file, "\n# only a comment\n", "utf8");
    const result = await runHook({ messageFile: file, type: "prepare-commit-msg" });
    expect(result.graded).toBe(false);
    expect(result.skipped).toBe("empty subject");
  });

  it("does not append commented block for commit-msg hook", async () => {
    await writeFile(file, "feat: nice subject line that is good\n", "utf8");
    const before = await readFile(file, "utf8");
    const result = await runHook({ messageFile: file, type: "commit-msg" });
    const after = await readFile(file, "utf8");
    expect(result.graded).toBe(true);
    expect(after).toBe(before);
  });
});
