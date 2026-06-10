# commit-roast — PLAN

## 1. Pitch
`commit-roast` is a tiny CLI that reads your last N git commits and roasts them with swappable AI personas — Linus Torvalds, a passive-aggressive PM, Shakespeare, your high-school English teacher. It can also **grade** commits against the Conventional Commits / "good commit message" rubric and (optionally) **rewrite** them in-place via `git commit --amend` / interactive rebase helpers. Equal parts dev-tool and dunk-tank.

## 2. Trend inspiration
- **Persona-driven AI CLIs** are everywhere on HN / r/commandline right now (everything from "AI rubber duck" tools to MCP-backed persona agents). Vibe-coding is in, dry linters are out.
- **Terminal Trove**'s "new TUI" feed is full of small, opinionated, single-purpose joy tools (`toofan` typing tester, `octoscope`, `steamfetch`). https://terminaltrove.com/new/
- **Conventional Commits / commitlint** are widely adopted but universally hated — devs grudgingly accept the rules and ignore the feedback. There's a real opening for "the lint feedback, but funny enough that I actually read it."
- **Reddit r/commandline / r/ExperiencedDevs** routinely upvote tiny one-purpose tools that make a chore (logs, git, k8s) more bearable. Humor + utility outperforms either alone.

## 3. Why it's different
- Existing tools (`commitlint`, `commitizen`, `aicommits`, `gptcommit`) either *generate* commit messages or *lint* them silently. None of them **roast** existing ones, none let you **swap personas**, and none give a **letter grade + rewrite suggestion** in the same pass.
- Our org has nothing in this space (checked `rwrife` repos and `ideas.md` — empty log). Closest cousin is `PilotLight` (a lightweight chat client) — different surface area entirely.
- Persona system is first-class and pluggable from day one — every persona is a single Markdown file in `personas/`, so the community can ship roasts as PRs.

## 4. MVP scope (v0.1)
- `commit-roast` reads last N commits (default 5) from `git log` in the current repo.
- For each commit: prints subject, short SHA, a **letter grade A–F**, a one-paragraph **roast** in the selected persona, and a **suggested rewrite** that conforms to Conventional Commits.
- Flags: `--persona <name>` (default `linus`), `--count <n>`, `--since <ref>`, `--no-color`, `--json`.
- Ships with 4 personas: `linus`, `pm` (passive-aggressive product manager), `bard` (Shakespeare), `teacher`.
- Uses an OpenAI-compatible endpoint (works with OpenAI, Ollama, LM Studio) configured via env: `ROAST_API_BASE`, `ROAST_API_KEY`, `ROAST_MODEL`.
- Offline fallback: if no API key, runs a **rule-based grader** that still hands out grades and canned roasts (no AI roast, but tool stays useful).

## 5. Tech stack
- **Node.js + TypeScript** (Node 20+). Reason: easy `npx commit-roast`, painless `simple-git` and `chalk`, ubiquitous on dev machines.
- **`commander`** for flag parsing, **`chalk`** for color, **`simple-git`** for log access, **`openai`** SDK pointed at any OAI-compatible base URL.
- **`vitest`** for tests, **`tsup`** for a single-file bin build, **`pnpm`** for installs.
- Boring on purpose. No framework gymnastics.

## 6. Architecture
```
src/
  bin.ts            # commander entrypoint, prints output
  git.ts            # `getRecentCommits(n, since)` via simple-git
  grader.ts         # rule-based scoring (length, type prefix, imperative mood, etc.)
  roaster.ts        # calls LLM with persona + commit; returns {roast, rewrite}
  personas/
    linus.md
    pm.md
    bard.md
    teacher.md
  personaLoader.ts  # reads markdown files into prompt templates
  render.ts         # pretty terminal output + --json mode
  config.ts         # env + ~/.commit-roastrc resolution
```
Each persona file is a Markdown prompt with a small frontmatter block (name, style, temperature). Adding a persona = adding a `.md` file.

## 7. Milestones
1. **M1 — scaffold + hello-world.** `pnpm init`, TS config, `tsup` bin build, `commit-roast --version` prints version. Repo lints and tests via `vitest` (one trivial test).
2. **M2 — git log reader + rule-based grader.** `commit-roast --count 5` prints subject, SHA, and a deterministic letter grade from `grader.ts` (no AI yet). Ships canned roast strings.
3. **M3 — persona system + LLM roaster.** Markdown personas with frontmatter, `personaLoader.ts`, OAI-compatible client. `--persona linus` produces a real roast + rewrite. Falls back to canned strings if `ROAST_API_KEY` missing.
4. **M4 — pretty output + JSON mode.** Color, padding, persona avatar/emoji, `--json` for scripting, `--no-color` for CI.
5. **M5 — config + remaining personas.** `~/.commit-roastrc` for defaults, ship `pm`, `bard`, `teacher` personas, document how to add your own.
6. **M6 — rewrite-in-place command.** `commit-roast rewrite <sha>` opens `git commit --amend` (HEAD) or generates an interactive `rebase --exec` script for older commits, pre-filling the suggested rewrite. Behind a confirmation prompt.

## 8. Backlog / future features (v0.2+)
1. **`--git-hook`**: install as a `prepare-commit-msg` hook that roasts before you push.
2. **Streak / leaderboard mode** — track grades across commits, show a sparkline of your "commit hygiene" over time.
3. **Team mode** — roast a PR diff's commits and post the roast as a GitHub PR comment.
4. **Persona marketplace** — `commit-roast personas add gh:user/repo/persona.md`.
5. **MCP server wrapper** — expose roast/grade/rewrite as MCP tools for Claude / Cursor / OpenClaw.
6. **Slack/Discord bot** — `/roast last 5 commits in repo X`.
7. **`--quiet`/`--strict`** for CI: exit non-zero if any commit grades below a threshold.
8. **Diff-aware roasts** — pass commit diff (truncated) to the model for more grounded feedback.
9. **Multi-language persona packs** — Spanish drill sergeant, anime senpai, French chef.
10. **Local model presets** — one-shot configs for `ollama run qwen2.5-coder`, `lmstudio`, etc.
11. **`commit-roast init`** — generates a Conventional Commits cheatsheet + git hook setup.
12. **Web UI** — paste a commit message, pick a persona, get a roast. Shareable URLs.

## 9. Out of scope
- Generating commit messages from scratch (that's `aicommits`/`gptcommit`'s job — we *react* to existing messages).
- Full rebase orchestration / conflict resolution. We only prep amend or `rebase --exec` scripts; the user drives the rest.
- A GUI, an IDE plugin, or a SaaS backend. CLI only for now.
- Hosting an LLM. We're a client.
- Non-git VCS support.
