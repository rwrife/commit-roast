import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEndpointJson,
  buildSvg,
  computeBadgeData,
  gradeToColor,
  runBadge,
} from "../src/badge.js";
import type { Commit } from "../src/git.js";

function mkCommit(partial: Partial<Commit>): Commit {
  return {
    sha: "0".repeat(40),
    shortSha: "0000000",
    subject: "",
    body: "",
    author: "alice",
    date: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("gradeToColor", () => {
  it.each([
    ["A", "brightgreen"],
    ["B", "green"],
    ["C", "yellowgreen"],
    ["D", "orange"],
    ["F", "red"],
  ] as const)("%s → %s", (grade, color) => {
    expect(gradeToColor(grade)).toBe(color);
  });
});

describe("computeBadgeData", () => {
  it("returns F badge for empty input", () => {
    const data = computeBadgeData([]);
    expect(data.grade).toBe("F");
    expect(data.count).toBe(0);
    expect(data.color).toBe("red");
    expect(data.label).toBe("commit grade");
    expect(data.message).toBe("F");
  });

  it("averages graded scores across commits", () => {
    const data = computeBadgeData([
      mkCommit({ subject: "feat(api): add user lookup endpoint" }),
      mkCommit({ subject: "fix(parser): handle trailing newline" }),
    ]);
    expect(data.count).toBe(2);
    expect(["A", "B"]).toContain(data.grade);
    expect(data.color).toBe(gradeToColor(data.grade));
  });
});

describe("buildEndpointJson", () => {
  it("emits valid shields.io endpoint shape", () => {
    const data = computeBadgeData([
      mkCommit({ subject: "feat(api): add user lookup endpoint" }),
    ]);
    const json = buildEndpointJson(data);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      schemaVersion: 1,
      label: "commit grade",
      message: data.message,
      color: data.color,
    });
  });
});

describe("buildSvg", () => {
  const data = computeBadgeData([
    mkCommit({ subject: "feat(api): add user lookup endpoint" }),
  ]);
  const svg = buildSvg(data);

  it("is well-formed and self-contained", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    // No external references — fonts, images, scripts, or stylesheets.
    expect(svg).not.toMatch(/<image\b/);
    expect(svg).not.toMatch(/<script\b/);
    expect(svg).not.toMatch(/href\s*=/i);
    expect(svg).not.toMatch(/xlink:href/);
    expect(svg).not.toMatch(/url\(http/i);
    expect(svg).not.toMatch(/@font-face/);
    expect(svg).not.toMatch(/<link\b/);
  });

  it("includes label and message text", () => {
    expect(svg).toContain("commit grade");
    expect(svg).toContain(`>${data.message}<`);
  });
});

describe("runBadge", () => {
  it("writes JSON to disk when --out is provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-roast-badge-"));
    const out = join(dir, "badge.json");
    try {
      const commits = [mkCommit({ subject: "feat: do the thing" })];
      const result = await runBadge(commits, { out });
      expect(result.writtenTo).toBe(out);
      const onDisk = readFileSync(out, "utf8");
      expect(JSON.parse(onDisk).schemaVersion).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes SVG to disk when --svg --out are provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-roast-badge-"));
    const out = join(dir, "badge.svg");
    try {
      const commits = [mkCommit({ subject: "feat: do the thing" })];
      const result = await runBadge(commits, { svg: true, out });
      expect(result.writtenTo).toBe(out);
      const onDisk = readFileSync(out, "utf8");
      expect(onDisk.startsWith("<svg")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns content without writing when --out is omitted", async () => {
    const commits = [mkCommit({ subject: "feat: do the thing" })];
    const result = await runBadge(commits);
    expect(result.writtenTo).toBeUndefined();
    expect(JSON.parse(result.content).schemaVersion).toBe(1);
  });
});
