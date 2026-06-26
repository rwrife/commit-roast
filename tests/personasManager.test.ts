import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSource,
  validatePersonaContent,
  addPersona,
  removePersona,
  listAllPersonas,
} from "../src/personasManager.js";
import { loadPersona } from "../src/personaLoader.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "commit-roast-personas-"));
}

const VALID_PERSONA = `---
name: drill
style: drill sergeant
temperature: 0.9
---

You are a drill sergeant. Be loud.
`;

describe("parseSource", () => {
  it("parses gh: with default ref", () => {
    const p = parseSource("gh:rwrife/commit-roast-personas/drill.md");
    expect(p.kind).toBe("gh");
    expect(p.url).toBe(
      "https://raw.githubusercontent.com/rwrife/commit-roast-personas/HEAD/drill.md"
    );
    expect(p.suggestedName).toBe("drill");
  });

  it("parses gh: with pinned ref and nested path", () => {
    const p = parseSource("gh:owner/repo@v1.2.3/personas/cool.md");
    expect(p.url).toBe(
      "https://raw.githubusercontent.com/owner/repo/v1.2.3/personas/cool.md"
    );
    expect(p.suggestedName).toBe("cool");
  });

  it("rejects malformed gh: source", () => {
    expect(() => parseSource("gh:owner")).toThrow(/Invalid gh:/);
  });

  it("parses raw https URLs", () => {
    const p = parseSource("https://example.com/foo/bar.md");
    expect(p.kind).toBe("http");
    expect(p.suggestedName).toBe("bar");
  });

  it("parses local relative paths", () => {
    const p = parseSource("./some/file.md");
    expect(p.kind).toBe("file");
    expect(p.filePath?.endsWith("some/file.md")).toBe(true);
    expect(p.suggestedName).toBe("file");
  });
});

describe("validatePersonaContent", () => {
  it("accepts valid persona", () => {
    const p = validatePersonaContent(VALID_PERSONA, "fallback");
    expect(p.name).toBe("drill");
    expect(p.style).toMatch(/drill/);
    expect(p.temperature).toBe(0.9);
  });

  it("rejects missing frontmatter", () => {
    expect(() => validatePersonaContent("just a body", "x")).toThrow(/frontmatter/);
  });

  it("rejects missing name", () => {
    const bad = `---\nstyle: foo\n---\nbody`;
    expect(() => validatePersonaContent(bad, "x")).toThrow(/name/);
  });

  it("rejects missing style", () => {
    const bad = `---\nname: foo\n---\nbody`;
    expect(() => validatePersonaContent(bad, "x")).toThrow(/style/);
  });

  it("rejects non-numeric temperature", () => {
    const bad = `---\nname: foo\nstyle: bar\ntemperature: hot\n---\nbody`;
    expect(() => validatePersonaContent(bad, "x")).toThrow(/temperature/);
  });

  it("rejects empty file", () => {
    expect(() => validatePersonaContent("", "x")).toThrow(/empty/);
  });
});

describe("addPersona / removePersona (local file)", () => {
  let home: string;
  let userDir: string;
  let srcDir: string;

  beforeEach(() => {
    home = makeTmp();
    userDir = join(home, ".commit-roast", "personas");
    srcDir = makeTmp();
  });

  it("installs from a local file and re-add fails without --force", async () => {
    const src = join(srcDir, "drill.md");
    writeFileSync(src, VALID_PERSONA, "utf8");
    const result = await addPersona(src, { home, userDir });
    expect(result.name).toBe("drill");
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("drill sergeant");

    await expect(addPersona(src, { home, userDir })).rejects.toThrow(/already installed/);

    const forced = await addPersona(src, { home, userDir, overwrite: true });
    expect(forced.path).toBe(result.path);
  });

  it("rejects malformed personas before writing", async () => {
    const src = join(srcDir, "bad.md");
    writeFileSync(src, "no frontmatter here", "utf8");
    await expect(addPersona(src, { home, userDir })).rejects.toThrow(/frontmatter/);
    expect(existsSync(join(userDir, "bad.md"))).toBe(false);
  });

  it("removes user-installed personas only", async () => {
    const src = join(srcDir, "drill.md");
    writeFileSync(src, VALID_PERSONA, "utf8");
    await addPersona(src, { home, userDir });
    const removed = await removePersona("drill", { home, userDir });
    expect(removed.removed).toBe(true);
    const again = await removePersona("drill", { home, userDir });
    expect(again.removed).toBe(false);
    expect(again.note).toMatch(/Built-in/);
  });
});

describe("listAllPersonas + loadPersona precedence", () => {
  it("user personas override built-ins of the same name", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    const builtinDir = makeTmp();
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(builtinDir, "linus.md"),
      `---\nname: linus\nstyle: builtin\n---\nbuiltin body`,
      "utf8"
    );
    writeFileSync(
      join(userDir, "linus.md"),
      `---\nname: linus\nstyle: user\n---\nuser body`,
      "utf8"
    );
    writeFileSync(
      join(userDir, "extra.md"),
      `---\nname: extra\nstyle: extra\n---\nbody`,
      "utf8"
    );

    const entries = await listAllPersonas({ home, userDir, builtinDir });
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.source]));
    expect(byName.linus).toBe("user");
    expect(byName.extra).toBe("user");

    const loaded = await loadPersona("linus", { home, userDir });
    expect(loaded.style).toBe("user");
  });
});
