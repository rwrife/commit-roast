import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInit, buildRcContents, buildCheatsheet } from "../src/init.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commit-roast-init-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("commit-roast init", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("buildRcContents writes JSON with the chosen persona/model", () => {
    expect(JSON.parse(buildRcContents("pm"))).toEqual({ persona: "pm" });
    expect(JSON.parse(buildRcContents("bard", "gpt-4o-mini"))).toEqual({
      persona: "bard",
      model: "gpt-4o-mini",
    });
  });

  it("buildCheatsheet returns Conventional Commits reference text", () => {
    const cheat = buildCheatsheet();
    expect(cheat).toMatch(/Conventional Commits/i);
    expect(cheat).toContain("`feat`");
    expect(cheat).toContain("`fix`");
  });

  it("creates rc, cheatsheet, and hook on a fresh init", async () => {
    const result = await runInit({ cwd: repo });
    const byName = Object.fromEntries(result.steps.map((s) => [s.name, s]));
    expect(byName.rc.status).toBe("created");
    expect(byName.cheatsheet.status).toBe("created");
    expect(byName.hook.status).toBe("created");

    const rc = JSON.parse(await readFile(join(repo, ".commit-roastrc"), "utf8"));
    expect(rc.persona).toBe("linus");

    expect(await exists(join(repo, "COMMIT_CHEATSHEET.md"))).toBe(true);
    const hookPath = join(repo, ".git", "hooks", "prepare-commit-msg");
    expect(await exists(hookPath)).toBe(true);
    const hookContents = await readFile(hookPath, "utf8");
    expect(hookContents).toContain("commit-roast: managed hook");
  });

  it("honors --persona and --model in the rc file", async () => {
    await runInit({ cwd: repo, persona: "pm", model: "gpt-4o-mini" });
    const rc = JSON.parse(await readFile(join(repo, ".commit-roastrc"), "utf8"));
    expect(rc).toEqual({ persona: "pm", model: "gpt-4o-mini" });
  });

  it("is idempotent on re-run: skips existing rc/cheatsheet/hook", async () => {
    await runInit({ cwd: repo });
    const second = await runInit({ cwd: repo });
    const byName = Object.fromEntries(second.steps.map((s) => [s.name, s]));
    expect(byName.rc.status).toBe("skipped");
    expect(byName.cheatsheet.status).toBe("skipped");
    // Hook installer treats its own marker as safe to overwrite, so this
    // is reported as "skipped" by our init layer (managedByCommitRoast).
    expect(byName.hook.status).toBe("skipped");
    expect(byName.hook.note).toMatch(/already installed/);
  });

  it("--force overwrites an existing rc and cheatsheet", async () => {
    await writeFile(join(repo, ".commit-roastrc"), "{\"persona\":\"bard\"}\n");
    await writeFile(join(repo, "COMMIT_CHEATSHEET.md"), "old\n");
    const result = await runInit({ cwd: repo, persona: "teacher", force: true });
    const byName = Object.fromEntries(result.steps.map((s) => [s.name, s]));
    expect(byName.rc.status).toBe("updated");
    expect(byName.cheatsheet.status).toBe("updated");

    const rc = JSON.parse(await readFile(join(repo, ".commit-roastrc"), "utf8"));
    expect(rc.persona).toBe("teacher");
    const cheat = await readFile(join(repo, "COMMIT_CHEATSHEET.md"), "utf8");
    expect(cheat).toMatch(/Conventional Commits/i);
  });

  it("refuses to overwrite an existing rc without --force", async () => {
    await writeFile(join(repo, ".commit-roastrc"), "{\"persona\":\"bard\"}\n");
    const result = await runInit({ cwd: repo, persona: "teacher" });
    const rcStep = result.steps.find((s) => s.name === "rc")!;
    expect(rcStep.status).toBe("skipped");
    expect(rcStep.note).toMatch(/already exists/);

    const rc = JSON.parse(await readFile(join(repo, ".commit-roastrc"), "utf8"));
    expect(rc.persona).toBe("bard"); // untouched
  });

  it("--no-hook skips hook installation", async () => {
    const result = await runInit({ cwd: repo, noHook: true });
    const hookStep = result.steps.find((s) => s.name === "hook")!;
    expect(hookStep.status).toBe("skipped");
    expect(hookStep.note).toBe("--no-hook");
    expect(await exists(join(repo, ".git", "hooks", "prepare-commit-msg"))).toBe(false);
  });

  it("--no-cheatsheet skips writing COMMIT_CHEATSHEET.md", async () => {
    const result = await runInit({ cwd: repo, noCheatsheet: true });
    const step = result.steps.find((s) => s.name === "cheatsheet")!;
    expect(step.status).toBe("skipped");
    expect(await exists(join(repo, "COMMIT_CHEATSHEET.md"))).toBe(false);
  });

  it("skips with a clear message when a non-commit-roast hook already exists", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(join(repo, ".git", "hooks", "prepare-commit-msg"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const result = await runInit({ cwd: repo });
    const hookStep = result.steps.find((s) => s.name === "hook")!;
    expect(hookStep.status).toBe("skipped");
    expect(hookStep.note).toMatch(/non-commit-roast hook|--force/);
  });

  it("returns a non-empty nextSteps summary", async () => {
    const result = await runInit({ cwd: repo });
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(result.nextSteps.some((l) => /persona/i.test(l))).toBe(true);
  });
});
