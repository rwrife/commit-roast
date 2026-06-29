import type { Commit, CommitDiff } from "./git.js";
import type { Persona } from "./personaLoader.js";

export interface RoastResult {
  roast: string;
  rewrite: string;
  source: "llm" | "fallback" | "cache";
}

export interface RoastCommitOptions {
  /** Optional truncated diff to ground the roast in actual code changes. */
  diff?: CommitDiff;
}

export interface RoasterConfig {
  apiBase?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Optional fetch impl, mostly for tests. */
  fetchImpl?: typeof fetch;
}

export function resolveConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallbacks: { model?: string; apiBase?: string } = {}
): RoasterConfig {
  return {
    apiBase: env.ROAST_API_BASE ?? fallbacks.apiBase ?? "https://api.openai.com/v1",
    apiKey: env.ROAST_API_KEY,
    model: env.ROAST_MODEL ?? fallbacks.model ?? "gpt-4o-mini",
    timeoutMs: Number(env.ROAST_TIMEOUT_MS ?? 20000),
  };
}

/** Canned offline roast. Keyed off grade so it isn't always the same line. */
export function fallbackRoast(commit: Commit, persona: Persona, grade: string): RoastResult {
  const byPersona: Record<string, string[]> = {
    linus: [
      "This subject is fine. Don't get cocky.",
      "Acceptable. Now stop touching the kernel.",
      "Mediocre. Try again, with feeling.",
      "Lazy. The repo deserves better.",
      "Garbage. Rewrite this before anyone else sees it.",
    ],
    pm: [
      "Love the energy here — just flagging we could tighten the framing 👍",
      "Helpful! Wondering if we can circle back on the wording 👍",
      "Quick nudge: let's align on a clearer subject next sprint 👍",
      "Friendly reminder that commit messages are also stakeholder comms 👍",
      "Happy to sync on what a *good* commit message looks like 👍",
    ],
    bard: [
      "A passable scroll, though no sonnet doth it inspire.",
      "Thy quill hath wavered; mend thy hand ere next thou commit.",
      "Forsooth, this message limpeth like a wounded hart.",
      "O cruel diff! Thy summary doth betray thee.",
      "A tragedy in one line — and not a good one.",
    ],
    teacher: [
      "Acceptable work. I expect more next time.",
      "*sigh* You're capable of better than this.",
      "Voice is muddled. Please revise.",
      "This would not pass a peer review. See me after class.",
      "F. Rewrite the entire thing. Use the rubric.",
    ],
  };
  const idx = { A: 0, B: 1, C: 2, D: 3, F: 4 }[grade as "A" | "B" | "C" | "D" | "F"] ?? 2;
  const lines = byPersona[persona.name] ?? byPersona.linus;
  const roast = lines[Math.min(idx, lines.length - 1)];

  // Trivial canned "rewrite": slap a conventional-commits-ish prefix on.
  const subj = commit.subject.trim() || "update code";
  const rewrite = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?:/i.test(subj)
    ? subj
    : `chore: ${subj.replace(/\.$/, "")}`;

  return { roast, rewrite, source: "fallback" };
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export function buildMessages(
  commit: Commit,
  persona: Persona,
  diff?: CommitDiff
): ChatMessage[] {
  const system = [
    persona.prompt,
    "",
    "Respond ONLY with minified JSON of the shape:",
    `{"roast":"<your roast>","rewrite":"<rewritten commit subject>"}`,
    "No prose outside the JSON. The rewrite must follow Conventional Commits",
    "(type[(scope)]: imperative subject, under 72 chars, no trailing period).",
    diff && diff.diff
      ? "You will also see a truncated diff. Use it to ground the roast in what actually changed (e.g. wrong type prefix, surprise behavior, dead code). Do not quote the diff back."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const parts = [
    `Commit subject: ${commit.subject}`,
    commit.body ? `Commit body:\n${commit.body}` : "(no commit body)",
  ];
  if (diff && diff.diff) {
    parts.push(
      `Diff (truncated, ${diff.bytes} bytes${diff.truncated ? ", cut at file boundary" : ""}):\n${diff.diff}`
    );
  }
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

export async function roastCommit(
  commit: Commit,
  persona: Persona,
  grade: string,
  config: RoasterConfig = resolveConfigFromEnv(),
  options: RoastCommitOptions = {}
): Promise<RoastResult> {
  if (!config.apiKey) {
    return fallbackRoast(commit, persona, grade);
  }
  const f = config.fetchImpl ?? fetch;
  const base = (config.apiBase ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 20000);
  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model ?? "gpt-4o-mini",
        temperature: persona.temperature,
        messages: buildMessages(commit, persona, options.diff),
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return fallbackRoast(commit, persona, grade);
    }
    const data = (await res.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseRoast(content);
    if (!parsed) return fallbackRoast(commit, persona, grade);
    return { roast: parsed.roast, rewrite: parsed.rewrite, source: "llm" };
  } catch {
    return fallbackRoast(commit, persona, grade);
  } finally {
    clearTimeout(timer);
  }
}

export function safeParseRoast(raw: string): { roast: string; rewrite: string } | null {
  if (!raw) return null;
  // Some models wrap JSON in ```json fences; strip them.
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.roast === "string" && typeof obj.rewrite === "string") {
      return { roast: obj.roast, rewrite: obj.rewrite };
    }
    return null;
  } catch {
    return null;
  }
}
