import type { Commit } from "./git.js";

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface GradeResult {
  grade: Grade;
  score: number; // 0..100
  reasons: string[]; // what dragged the score down (or up)
  roast: string; // canned roast string keyed off the worst offense
}

const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

// Words that strongly imply non-imperative mood as the first word of a subject.
// (Heuristic, not a linguistics PhD.)
const NON_IMPERATIVE_FIRST_WORDS = new Set([
  // -ed past tense
  "added",
  "fixed",
  "updated",
  "removed",
  "changed",
  "deleted",
  "renamed",
  "moved",
  "refactored",
  "improved",
  "tweaked",
  "bumped",
  "merged",
  "created",
  "implemented",
  "introduced",
  "cleaned",
  // -ing gerunds
  "adding",
  "fixing",
  "updating",
  "removing",
  "changing",
  "deleting",
  "renaming",
  "moving",
  "refactoring",
  "improving",
  "tweaking",
  "bumping",
  "merging",
  "creating",
  "implementing",
  "introducing",
  "cleaning",
  // 3rd person singular
  "adds",
  "fixes",
  "updates",
  "removes",
  "changes",
  "deletes",
]);

const LAZY_SUBJECTS = new Set([
  "wip",
  "fix",
  "fixes",
  "fix stuff",
  "stuff",
  "asdf",
  "update",
  "updates",
  "changes",
  "misc",
  "tweaks",
  "more",
  "more changes",
  ".",
  "...",
]);

const CONVENTIONAL_RE =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s+\S/;

export function gradeCommit(commit: Commit): GradeResult {
  const subject = (commit.subject ?? "").trim();
  const body = (commit.body ?? "").trim();
  const reasons: string[] = [];
  let score = 100;

  // 1. Empty subject — instant F.
  if (!subject) {
    return {
      grade: "F",
      score: 0,
      reasons: ["empty subject"],
      roast: "You committed without a message. A void. A whisper. A war crime against `git log`.",
    };
  }

  // 2. Lazy/garbage subjects.
  if (LAZY_SUBJECTS.has(subject.toLowerCase())) {
    return {
      grade: "F",
      score: 5,
      reasons: [`lazy subject: "${subject}"`],
      roast: `"${subject}" is not a commit message, it's a confession.`,
    };
  }

  // 3. Length checks (50/72 rule, roughly).
  if (subject.length < 10) {
    score -= 25;
    reasons.push(`subject too short (${subject.length} chars; aim for 10–72)`);
  } else if (subject.length > 72) {
    score -= 20;
    reasons.push(`subject too long (${subject.length} chars; keep under 72)`);
  } else if (subject.length > 50) {
    score -= 5;
    reasons.push(`subject borderline long (${subject.length} chars; ideal ≤ 50)`);
  }

  // 4. Trailing period in subject.
  if (subject.endsWith(".")) {
    score -= 5;
    reasons.push("subject ends with a period");
  }

  // 5. Conventional Commits prefix.
  const conv = CONVENTIONAL_RE.exec(subject);
  if (!conv) {
    score -= 20;
    reasons.push("missing Conventional Commits type prefix (e.g. `feat:`, `fix(scope):`)");
  } else {
    const type = conv.groups?.type?.toLowerCase() ?? "";
    if (!CONVENTIONAL_TYPES.includes(type)) {
      score -= 10;
      reasons.push(`unknown commit type "${type}"`);
    }
  }

  // 6. Imperative mood check on first word of the *description*.
  const description = conv ? subject.slice(conv[0].length - 1).trim() : subject;
  const firstWord = (description.match(/^[A-Za-z']+/)?.[0] ?? "").toLowerCase();
  if (firstWord && NON_IMPERATIVE_FIRST_WORDS.has(firstWord)) {
    score -= 15;
    reasons.push(`non-imperative mood ("${firstWord}"); prefer "add"/"fix"/"update"`);
  }

  // 7. Capitalization after the type prefix.
  if (description && /^[a-z]/.test(description)) {
    // Conventional Commits is fine with lowercase; only nudge if there's *no* prefix.
    if (!conv) {
      score -= 3;
      reasons.push("subject should start with a capital letter when no type prefix is used");
    }
  } else if (description && /^[A-Z]/.test(description) && conv) {
    score -= 2;
    reasons.push("description after type prefix is usually lowercase");
  }

  // 8. Subject/body separation: if body present, there must be a blank line.
  //    `simple-git` already gives body separate from subject, so we just reward presence.
  if (body.length > 0) {
    score += 5;
    reasons.push("includes a body — nice");
  }

  // Clamp and grade.
  score = Math.max(0, Math.min(100, score));

  const grade: Grade =
    score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

  return { grade, score, reasons, roast: cannedRoast(grade, reasons) };
}

function cannedRoast(grade: Grade, reasons: string[]): string {
  // Pick a roast keyed off the worst (first) reason when possible.
  const r = reasons[0]?.toLowerCase() ?? "";
  if (r.includes("lazy") || r.includes("empty")) {
    return "A commit message in the same way a shrug is a conversation.";
  }
  if (r.includes("too short")) {
    return "Brevity is the soul of wit. This is just the corpse.";
  }
  if (r.includes("too long")) {
    return "Subject line, not subject paragraph. Save the novel for the body.";
  }
  if (r.includes("conventional commits")) {
    return "No `feat:`, no `fix:`, no rules. Just vibes. Bold strategy.";
  }
  if (r.includes("non-imperative")) {
    return "Past tense in commit messages is how I know you also write README.md last.";
  }
  if (r.includes("period")) {
    return "A period at the end of a subject line. Bold. Wrong, but bold.";
  }
  switch (grade) {
    case "A":
      return "Annoyingly competent. I have nothing.";
    case "B":
      return "Solid. Boring. Like a well-named function.";
    case "C":
      return "It conveys something. The bar is on the floor and you cleared it.";
    case "D":
      return "Future-you is going to hate present-you for this one.";
    case "F":
    default:
      return "I've seen better commit messages from `git revert` defaults.";
  }
}
