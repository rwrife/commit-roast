import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { getCommitDiff } from "../src/git.js";

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
