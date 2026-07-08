import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  buildReport,
  renderReportJson,
  renderReportMarkdown,
  renderReportHtml,
  renderSparklineSvg,
  escapeMd,
  escapeHtml,
} from "../src/report.js";
import type { Persona } from "../src/personaLoader.js";

const FIXED_DATE = new Date("2026-07-01T12:00:00Z");
const now = () => FIXED_DATE;

// Persona shim so tests don't hit the filesystem persona loader.
const fakePersona: Persona = {
  name: "linus",
  style: "test",
  prompt: "test",
  temperature: 0.5,
};

describe("report renderers", () => {
  let dir: string;
  let g: SimpleGit;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "commit-roast-report-"));
    g = simpleGit(dir);
    await g.init();
    await g.addConfig("user.email", "alice@example.com");
    await g.addConfig("user.name", "Alice");
    // Origin so the report picks up a stable repo name.
    await g.raw(["remote", "add", "origin", "https://example.com/acme/widgets.git"]);

    async function commitAs(
      subject: string,
      iso: string,
      who: { name: string; email: string },
      file: string
    ) {
      writeFileSync(join(dir, file), file + "\n");
      await g.add(file);
      await g
        .env({
          GIT_AUTHOR_DATE: iso,
          GIT_COMMITTER_DATE: iso,
          GIT_AUTHOR_NAME: who.name,
          GIT_AUTHOR_EMAIL: who.email,
          GIT_COMMITTER_NAME: who.name,
          GIT_COMMITTER_EMAIL: who.email,
          PATH: process.env.PATH ?? "",
        })
        .raw(["commit", "-m", subject, "--date", iso]);
    }

    // Mix of grades: a great subject, a mediocre one, and a lazy one, from
    // two authors, backdated so date range assertions are stable.
    await commitAs(
      "feat(api): add user lookup endpoint",
      "2026-06-01T00:00:00Z",
      { name: "Alice", email: "alice@example.com" },
      "a.txt"
    );
    await commitAs(
      "fix typo",
      "2026-06-15T00:00:00Z",
      { name: "Bob", email: "bob@example.com" },
      "b.txt"
    );
    await commitAs(
      "wip",
      "2026-06-20T00:00:00Z",
      { name: "Bob", email: "bob@example.com" },
      "c.txt"
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds a report with author and date filters", async () => {
    const data = await buildReport({
      cwd: dir,
      since: "2026-05-01",
      until: "2026-07-01",
      lowlights: 0,
      now,
    });
    expect(data.repo).toBe("widgets");
    expect(data.total).toBe(3);
    expect(data.since).toBe("2026-05-01");
    expect(data.until).toBe("2026-07-01");
    expect(Object.keys(data.summary.byAuthor).sort()).toEqual(["Alice", "Bob"]);
    expect(data.summary.distribution.F).toBeGreaterThanOrEqual(1);
    // No lowlights requested → empty section.
    expect(data.lowlights).toEqual([]);
    expect(data.persona).toBeUndefined();
  });

  it("respects --author filter", async () => {
    const data = await buildReport({ cwd: dir, author: "Alice", now });
    expect(data.total).toBe(1);
    expect(Object.keys(data.summary.byAuthor)).toEqual(["Alice"]);
  });

  it("populates lowlights with deterministic canned roasts (no api key)", async () => {
    const data = await buildReport({
      cwd: dir,
      lowlights: 2,
      persona: fakePersona,
      // No config → fallback path (deterministic per-persona/grade string).
      now,
    });
    expect(data.lowlights).toHaveLength(2);
    // Sorted lowest-score first, tie-broken by subject alphabetically.
    expect(data.lowlights[0]!.grade).toBe("F");
    expect(data.lowlights[0]!.commit.subject).toBe("wip");
    expect(data.lowlights[0]!.source).toBe("fallback");
    expect(data.persona).toBe("linus");
  });

  it("routes to a custom roast fn when provided", async () => {
    const seen: string[] = [];
    const data = await buildReport({
      cwd: dir,
      lowlights: 1,
      persona: fakePersona,
      now,
      roastFn: async (commit) => {
        seen.push(commit.subject);
        return { roast: `custom(${commit.subject})`, rewrite: commit.subject, source: "llm" };
      },
    });
    expect(seen).toEqual(["wip"]);
    expect(data.lowlights[0]!.roast).toBe("custom(wip)");
    expect(data.lowlights[0]!.source).toBe("llm");
  });

  it("renders a stable Markdown snapshot", async () => {
    const data = await buildReport({
      cwd: dir,
      since: "2026-05-01",
      until: "2026-07-01",
      lowlights: 1,
      persona: fakePersona,
      now,
    });
    const md = renderReportMarkdown(data);
    // Header + range line are visible up front.
    expect(md).toMatch(/^# 🔥 commit-roast report — widgets/m);
    expect(md).toMatch(/since \*\*2026-05-01\*\*/);
    expect(md).toMatch(/until \*\*2026-07-01\*\*/);
    // Distribution and per-author tables render.
    expect(md).toMatch(/## Grade distribution/);
    expect(md).toMatch(/## By author/);
    expect(md).toMatch(/\| Alice \|/);
    expect(md).toMatch(/\| Bob \|/);
    // Lowlights section renders with our persona and the worst commit.
    expect(md).toMatch(/## Lowlights/);
    expect(md).toMatch(/_Roasted by \*\*linus\*\*\._/);
    expect(md).toMatch(/### F \(\d+\).*wip/);
    // Generated stamp uses the fixed clock.
    expect(md).toContain(FIXED_DATE.toISOString());
  });

  it("renders a stable JSON snapshot", async () => {
    const data = await buildReport({
      cwd: dir,
      since: "2026-05-01",
      until: "2026-07-01",
      lowlights: 1,
      persona: fakePersona,
      now,
    });
    const json = JSON.parse(renderReportJson(data));
    expect(json.repo).toBe("widgets");
    expect(json.range).toEqual({ since: "2026-05-01", until: "2026-07-01", author: null });
    expect(json.total).toBe(3);
    expect(json.averageGrade).toMatch(/[A-F]/);
    expect(json.distribution).toMatchObject({ A: expect.any(Number), F: expect.any(Number) });
    expect(json.byAuthor).toHaveLength(2);
    expect(json.lowlights).toHaveLength(1);
    expect(json.lowlights[0]).toMatchObject({
      subject: "wip",
      grade: "F",
      source: "fallback",
    });
    expect(json.persona).toBe("linus");
  });

  it("renders self-contained HTML with no external requests", async () => {
    const data = await buildReport({
      cwd: dir,
      since: "2026-05-01",
      until: "2026-07-01",
      lowlights: 1,
      persona: fakePersona,
      now,
    });
    const html = renderReportHtml(data);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>commit-roast report — widgets</title>");
    // Inline styles present; no <link href> / <script src>.
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link[^>]*href=/i);
    expect(html).not.toMatch(/<script[^>]*src=/i);
    // Only external URL should be the SVG namespace.
    const httpUrls = [...html.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]);
    expect(httpUrls).toEqual(["http://www.w3.org/2000/svg"]);
    // Inline SVG sparkline rendered.
    expect(html).toContain('class="spark"');
    expect(html).toContain('<svg');
    // Well-formed enough: every opened tag we emit closes (basic sanity).
    for (const tag of ["html", "head", "body", "main", "style", "table", "svg"]) {
      const opens = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length;
      const closes = (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      expect(opens).toBe(closes);
    }
    // Contains our authors and the worst commit subject.
    expect(html).toContain(">Alice<");
    expect(html).toContain(">Bob<");
    expect(html).toContain("wip");
  });

  it("handles empty results gracefully", async () => {
    const data = await buildReport({ cwd: dir, since: "2099-01-01", now });
    expect(data.total).toBe(0);
    expect(renderReportMarkdown(data)).toMatch(/No commits matched/);
    expect(renderReportHtml(data)).toMatch(/No commits matched/);
    const json = JSON.parse(renderReportJson(data));
    expect(json.total).toBe(0);
    expect(json.byAuthor).toEqual([]);
  });
});

describe("report helpers", () => {
  it("escapes Markdown pipes/backticks/backslashes and folds newlines", () => {
    expect(escapeMd("a | b `x` \\ y\nz")).toBe("a \\| b \\`x\\` \\\\ y z");
  });

  it("escapes HTML entities", () => {
    expect(escapeHtml(`<script>"&'</script>`)).toBe(
      "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;"
    );
  });

  it("renderSparklineSvg emits a placeholder for empty scores", () => {
    expect(renderSparklineSvg([])).toContain('<span class="spark');
  });

  it("renderSparklineSvg emits one rect per score", () => {
    const svg = renderSparklineSvg([10, 50, 100]);
    expect(svg).toContain("<svg");
    const rects = svg.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(3);
  });
});
