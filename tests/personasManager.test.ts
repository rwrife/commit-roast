import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSource,
  validatePersonaContent,
  addPersona,
  addPersonasFromRepo,
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
    expect(p.ref).toBe("v1.2.3");
  });

  it("opts.ref overrides an @ref embedded in the source", () => {
    const p = parseSource("gh:owner/repo@v1/persona.md", { ref: "main" });
    expect(p.url).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/persona.md"
    );
    expect(p.ref).toBe("main");
  });

  it("parses bare gh:owner/repo as a gh-dir source", () => {
    const p = parseSource("gh:owner/repo");
    expect(p.kind).toBe("gh-dir");
    expect(p.owner).toBe("owner");
    expect(p.repo).toBe("repo");
    expect(p.ref).toBe("HEAD");
    expect(p.dirPath).toBe("personas");
    expect(p.suggestedName).toBe("repo");
    expect(p.url).toBeUndefined();
  });

  it("parses bare gh:owner/repo@ref as a gh-dir source with a ref", () => {
    const p = parseSource("gh:owner/repo@v2.0.0");
    expect(p.kind).toBe("gh-dir");
    expect(p.ref).toBe("v2.0.0");
  });

  it("opts.ref also overrides for gh-dir sources", () => {
    const p = parseSource("gh:owner/repo", { ref: "main" });
    expect(p.kind).toBe("gh-dir");
    expect(p.ref).toBe("main");
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

describe("addPersonasFromRepo (bulk install)", () => {
  const VALID_A = `---\nname: alpha\nstyle: a\n---\nbody A\n`;
  const VALID_B = `---\nname: beta\nstyle: b\n---\nbody B\n`;
  const BAD = `no frontmatter`;

  function makeFetch(map: Record<string, { status: number; body: string; statusText?: string }>): typeof fetch {
    // Minimal typed shim; we only implement what the code path uses.
    return (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const hit = map[url];
      if (!hit) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return new Response(hit.body, {
        status: hit.status,
        statusText: hit.statusText,
      });
    }) as unknown as typeof fetch;
  }

  it("installs every .md under personas/ from a bare gh:owner/repo source", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    const listing = [
      {
        name: "alpha.md",
        path: "personas/alpha.md",
        type: "file",
        download_url:
          "https://raw.githubusercontent.com/owner/repo/HEAD/personas/alpha.md",
      },
      {
        name: "beta.md",
        path: "personas/beta.md",
        type: "file",
        download_url:
          "https://raw.githubusercontent.com/owner/repo/HEAD/personas/beta.md",
      },
      // Non-markdown / directory entries must be ignored.
      { name: "README.md", path: "personas/README.md", type: "file", download_url: null },
      { name: "nested", path: "personas/nested", type: "dir", download_url: null },
    ];
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/owner/repo/contents/personas?ref=HEAD": {
        status: 200,
        body: JSON.stringify(listing),
      },
      "https://raw.githubusercontent.com/owner/repo/HEAD/personas/alpha.md": {
        status: 200,
        body: VALID_A,
      },
      "https://raw.githubusercontent.com/owner/repo/HEAD/personas/beta.md": {
        status: 200,
        body: VALID_B,
      },
    });

    const result = await addPersonasFromRepo("gh:owner/repo", {
      home,
      userDir,
      fetchImpl,
    });
    expect(result.installed.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(userDir, "alpha.md"))).toBe(true);
    expect(existsSync(join(userDir, "beta.md"))).toBe(true);
  });

  it("honors --ref (opts.ref) when hitting the contents API", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/owner/repo/contents/personas?ref=main": {
        status: 200,
        body: JSON.stringify([
          {
            name: "alpha.md",
            path: "personas/alpha.md",
            type: "file",
            download_url:
              "https://raw.githubusercontent.com/owner/repo/main/personas/alpha.md",
          },
        ]),
      },
      "https://raw.githubusercontent.com/owner/repo/main/personas/alpha.md": {
        status: 200,
        body: VALID_A,
      },
    });
    const result = await addPersonasFromRepo("gh:owner/repo", {
      home,
      userDir,
      fetchImpl,
      ref: "main",
    });
    expect(result.installed).toHaveLength(1);
    expect(result.installed[0].name).toBe("alpha");
  });

  it("raises a clear error on 404 (no personas/ dir)", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/owner/repo/contents/personas?ref=HEAD": {
        status: 404,
        body: "Not Found",
        statusText: "Not Found",
      },
    });
    await expect(
      addPersonasFromRepo("gh:owner/repo", { home, userDir, fetchImpl })
    ).rejects.toThrow(/No `personas\/` directory/);
  });

  it("raises a rate-limit hint on 403", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/owner/repo/contents/personas?ref=HEAD": {
        status: 403,
        body: "forbidden",
        statusText: "Forbidden",
      },
    });
    await expect(
      addPersonasFromRepo("gh:owner/repo", { home, userDir, fetchImpl })
    ).rejects.toThrow(/rate-limited/);
  });

  it("errors when the directory has no .md files", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/owner/repo/contents/personas?ref=HEAD": {
        status: 200,
        body: JSON.stringify([
          { name: "README", path: "personas/README", type: "file", download_url: "x" },
          { name: "sub", path: "personas/sub", type: "dir", download_url: null },
        ]),
      },
    });
    await expect(
      addPersonasFromRepo("gh:owner/repo", { home, userDir, fetchImpl })
    ).rejects.toThrow(/No .md persona files/);
  });

  it("skips (does not abort) individual files that fail validation or already exist", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    // Pre-install alpha so the second attempt hits the overwrite guard.
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "alpha.md"), VALID_A, "utf8");
    const listing = [
      {
        name: "alpha.md",
        path: "personas/alpha.md",
        type: "file",
        download_url:
          "https://raw.githubusercontent.com/owner/repo/HEAD/personas/alpha.md",
      },
      {
        name: "beta.md",
        path: "personas/beta.md",
        type: "file",
        download_url:
          "https://raw.githubusercontent.com/owner/repo/HEAD/personas/beta.md",
      },
      {
        name: "bad.md",
        path: "personas/bad.md",
        type: "file",
        download_url:
          "https://raw.githubusercontent.com/owner/repo/HEAD/personas/bad.md",
      },
    ];
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/owner/repo/contents/personas?ref=HEAD": {
        status: 200,
        body: JSON.stringify(listing),
      },
      "https://raw.githubusercontent.com/owner/repo/HEAD/personas/alpha.md": {
        status: 200,
        body: VALID_A,
      },
      "https://raw.githubusercontent.com/owner/repo/HEAD/personas/beta.md": {
        status: 200,
        body: VALID_B,
      },
      "https://raw.githubusercontent.com/owner/repo/HEAD/personas/bad.md": {
        status: 200,
        body: BAD,
      },
    });
    const result = await addPersonasFromRepo("gh:owner/repo", {
      home,
      userDir,
      fetchImpl,
    });
    expect(result.installed.map((r) => r.name)).toEqual(["beta"]);
    const skippedPaths = result.skipped.map((s) => s.path).sort();
    expect(skippedPaths).toEqual(["personas/alpha.md", "personas/bad.md"]);
    // Alpha reason should mention --force; bad should mention frontmatter.
    const alphaReason =
      result.skipped.find((s) => s.path === "personas/alpha.md")?.reason ?? "";
    const badReason =
      result.skipped.find((s) => s.path === "personas/bad.md")?.reason ?? "";
    expect(alphaReason).toMatch(/--force/);
    expect(badReason).toMatch(/frontmatter/);
  });

  it("--force overwrites conflicting files during bulk install", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "alpha.md"), "old contents", "utf8");
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/owner/repo/contents/personas?ref=HEAD": {
        status: 200,
        body: JSON.stringify([
          {
            name: "alpha.md",
            path: "personas/alpha.md",
            type: "file",
            download_url:
              "https://raw.githubusercontent.com/owner/repo/HEAD/personas/alpha.md",
          },
        ]),
      },
      "https://raw.githubusercontent.com/owner/repo/HEAD/personas/alpha.md": {
        status: 200,
        body: VALID_A,
      },
    });
    const result = await addPersonasFromRepo("gh:owner/repo", {
      home,
      userDir,
      fetchImpl,
      overwrite: true,
    });
    expect(result.installed).toHaveLength(1);
    expect(readFileSync(join(userDir, "alpha.md"), "utf8")).toContain("body A");
  });

  it("rejects gh-dir sources in addPersona (single-file API)", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    await expect(addPersona("gh:owner/repo", { home, userDir })).rejects.toThrow(
      /whole repo/
    );
  });

  it("rejects single-file sources in addPersonasFromRepo (bulk API)", async () => {
    const home = makeTmp();
    const userDir = join(home, ".commit-roast", "personas");
    await expect(
      addPersonasFromRepo("gh:owner/repo/foo.md", { home, userDir })
    ).rejects.toThrow(/single-file source/);
  });
});
