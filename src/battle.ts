import type { Commit, CommitDiff } from "./git.js";
import type { Persona } from "./personaLoader.js";
import { loadPersona } from "./personaLoader.js";
import { fallbackRoast, roastCommit, type RoasterConfig, type RoastResult } from "./roaster.js";
import { makeCacheKey, type RoastCache } from "./cache.js";

/**
 * A single persona's take in a Roast Battle.
 * Shape mirrors {@link RoastResult} plus the persona label so JSON consumers
 * can attribute each roast without a parallel array lookup.
 */
export interface BattleEntry {
  persona: string;
  roast: string;
  rewrite: string;
  source: RoastResult["source"];
}

export interface JudgeResult {
  /** Persona name of the winning roast. */
  winner: string;
  /** One-sentence justification. */
  reason: string;
  /** `llm` when an LLM chose the winner, `offline` for the deterministic
   *  fallback, `fallback` for LLM-attempted-but-failed. */
  source: "llm" | "offline" | "fallback";
}

/** Terminal width required before `--side-by-side` splits into columns. */
export const SIDE_BY_SIDE_MIN_COLS = 120;

/**
 * Parse the raw `--battle` value. Accepts a comma-separated list of persona
 * names, requires 2–4 entries, trims whitespace, lowercases, and de-dupes
 * while preserving order (a persona can't battle itself).
 */
export function parseBattleFlag(raw: string): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("--battle needs a comma-separated list of personas, e.g. --battle linus,pm");
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const p of parts) {
    if (!/^[a-z0-9_-]+$/.test(p)) {
      throw new Error(`--battle: invalid persona name "${p}" (letters, digits, _ and - only)`);
    }
    if (!seen.has(p)) {
      seen.add(p);
      uniq.push(p);
    }
  }
  if (uniq.length < 2 || uniq.length > 4) {
    throw new Error(
      `--battle expects 2–4 personas, got ${uniq.length}. Example: --battle linus,pm,bard`
    );
  }
  return uniq;
}

/**
 * Load each persona in {@link names}, surfacing a friendly error listing
 * every persona that failed (rather than bailing on the first miss).
 */
export async function loadBattlePersonas(names: string[]): Promise<Persona[]> {
  const loaded: Persona[] = [];
  const failures: string[] = [];
  for (const name of names) {
    try {
      loaded.push(await loadPersona(name));
    } catch (err) {
      failures.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`--battle: could not load persona(s): ${failures.join("; ")}`);
  }
  return loaded;
}

export interface RunBattleOptions {
  commit: Commit;
  personas: Persona[];
  grade: string;
  config: RoasterConfig;
  cache?: RoastCache | null;
  diff?: CommitDiff;
  /** When true, do no LLM calls; every entry is `fallback`. */
  offline?: boolean;
}

/**
 * Run one roast call per persona for a single commit.
 *
 * Reuses the caller-supplied {@link RoastCache} keyed by the same
 * `(commitSha, persona, model)` triple as the non-battle path, so:
 *   - non-battle roasts warm the battle cache and vice versa
 *   - two personas in the same battle each get their own cache entry
 */
export async function runBattle(opts: RunBattleOptions): Promise<BattleEntry[]> {
  const { commit, personas, grade, config, cache, diff, offline } = opts;
  const entries: BattleEntry[] = [];
  for (const persona of personas) {
    if (offline) {
      const r = fallbackRoast(commit, persona, grade);
      entries.push({
        persona: persona.name,
        roast: r.roast,
        rewrite: r.rewrite,
        source: r.source,
      });
      continue;
    }
    const cacheKey = cache
      ? makeCacheKey({
          commitSha: commit.sha,
          persona: persona.name,
          model: config.model ?? "",
        })
      : null;
    const cached = cache && cacheKey ? await cache.get(cacheKey) : undefined;
    let result: RoastResult;
    if (cached) {
      result = { roast: cached.roast, rewrite: cached.rewrite, source: "cache" };
    } else {
      result = await roastCommit(commit, persona, grade, config, diff ? { diff } : {});
      if (cache && cacheKey && result.source === "llm") {
        await cache.set(cacheKey, { roast: result.roast, rewrite: result.rewrite });
      }
    }
    entries.push({
      persona: persona.name,
      roast: result.roast,
      rewrite: result.rewrite,
      source: result.source,
    });
  }
  return entries;
}

interface JudgeChatMessage {
  role: "system" | "user";
  content: string;
}

interface JudgeChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Build the judge prompt. Kept small on purpose: one commit subject and the
 * competing roasts, plus a strict JSON contract. No diffs — the judge is
 * evaluating the *roasts*, not the code.
 */
export function buildJudgeMessages(
  commit: Commit,
  entries: BattleEntry[]
): JudgeChatMessage[] {
  const roasts = entries
    .map((e, i) => `${i + 1}. [${e.persona}] ${e.roast}`)
    .join("\n");
  const personas = entries.map((e) => e.persona).join(", ");
  const system = [
    "You are the impartial judge of a commit-message Roast Battle.",
    "Given a commit subject and one roast per persona, pick the single funniest and most on-target roast.",
    "Prefer roasts that are specific to the commit over generic burns.",
    "Ties are not allowed — always pick one winner.",
    "",
    "Respond ONLY with minified JSON of the shape:",
    `{"winner":"<persona name>","reason":"<one short sentence>"}`,
    `The winner MUST be one of: ${personas}.`,
  ].join("\n");
  const user = [
    `Commit subject: ${commit.subject}`,
    "",
    "Roasts:",
    roasts,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Deterministic offline judge. Used both when there's no API key and as the
 * safe fallback when the LLM's JSON is unparseable / picks a persona not in
 * the battle.
 *
 * Heuristic: prefer roasts that name-drop the commit's subject words
 * (specificity wins); otherwise pick the longest roast; ties broken by
 * order (first persona listed).
 */
export function offlineJudge(commit: Commit, entries: BattleEntry[]): JudgeResult {
  if (entries.length === 0) {
    // Callers shouldn't hit this, but return something rather than crash.
    return { winner: "", reason: "no roasts to judge", source: "offline" };
  }
  const subjectWords = new Set(
    (commit.subject ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4)
  );
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < entries.length; i += 1) {
    const roast = entries[i]!.roast.toLowerCase();
    let hits = 0;
    for (const w of subjectWords) {
      if (roast.includes(w)) hits += 1;
    }
    // Score: specificity dominates, tiebreak by length so the more
    // developed roast wins over a one-liner.
    const score = hits * 1000 + Math.min(entries[i]!.roast.length, 500);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const winner = entries[bestIdx]!;
  const reason = subjectWords.size > 0 && bestScore >= 1000
    ? `${winner.persona} landed the most commit-specific hit (offline judge).`
    : `${winner.persona} delivered the meatier roast (offline judge).`;
  return { winner: winner.persona, reason, source: "offline" };
}

export interface JudgeBattleOptions {
  commit: Commit;
  entries: BattleEntry[];
  config: RoasterConfig;
}

/**
 * Ask the configured LLM to pick a winner. On any of:
 *   - missing API key
 *   - network / non-2xx / timeout
 *   - unparseable JSON
 *   - LLM picks a persona not in the battle
 *
 * ...we fall back to {@link offlineJudge}. Never throws.
 */
export async function judgeBattle(opts: JudgeBattleOptions): Promise<JudgeResult> {
  const { commit, entries, config } = opts;
  if (entries.length === 0) {
    return { winner: "", reason: "no roasts to judge", source: "offline" };
  }
  if (!config.apiKey) {
    return offlineJudge(commit, entries);
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
        // Lower temperature — the judge should be decisive, not creative.
        temperature: 0.2,
        messages: buildJudgeMessages(commit, entries),
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const fb = offlineJudge(commit, entries);
      return { ...fb, source: "fallback" };
    }
    const data = (await res.json()) as JudgeChatResponse;
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseJudge(content);
    if (!parsed) {
      const fb = offlineJudge(commit, entries);
      return { ...fb, source: "fallback" };
    }
    // Guard: LLM must pick a persona that actually competed.
    const validNames = new Set(entries.map((e) => e.persona));
    if (!validNames.has(parsed.winner)) {
      const fb = offlineJudge(commit, entries);
      return { ...fb, source: "fallback" };
    }
    return { winner: parsed.winner, reason: parsed.reason, source: "llm" };
  } catch {
    const fb = offlineJudge(commit, entries);
    return { ...fb, source: "fallback" };
  } finally {
    clearTimeout(timer);
  }
}

export function safeParseJudge(raw: string): { winner: string; reason: string } | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (
      obj &&
      typeof obj.winner === "string" &&
      obj.winner.trim() &&
      typeof obj.reason === "string"
    ) {
      return { winner: obj.winner.trim().toLowerCase(), reason: obj.reason.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide whether to render battles side-by-side. Split into a helper so
 * tests can exercise the width breakpoint without touching `process.stdout`.
 */
export function shouldRenderSideBySide(
  requested: boolean | undefined,
  cols: number | undefined,
  personaCount: number
): boolean {
  if (!requested) return false;
  if (personaCount < 2) return false;
  const width = typeof cols === "number" && cols > 0 ? cols : 0;
  return width >= SIDE_BY_SIDE_MIN_COLS;
}
