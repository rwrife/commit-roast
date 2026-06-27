# commit-roast

Roast your last N git commits with swappable AI personas — Linus, a passive-aggressive PM, Shakespeare, your high-school English teacher. Equal parts dev-tool and dunk-tank.

See [PLAN.md](./PLAN.md) for the full pitch and roadmap.

## Status

🚧 Pre-alpha. M1–M4 are in. The CLI reads your git log, grades each commit, and (with an API key) roasts + rewrites with an LLM persona. No key? It falls back to canned roasts so the tool still does something useful.

## Quick start

```bash
pnpm install
pnpm build
pnpm test

# run the CLI
node ./dist/bin.mjs --help
node ./dist/bin.mjs --version
node ./dist/bin.mjs --count 3 --persona linus
node ./dist/bin.mjs --count 3 --json        # machine-readable output
node ./dist/bin.mjs --count 3 --no-color    # CI-friendly, also honors NO_COLOR
```

## Output modes

Pretty (default): colorized, with a persona emoji, letter-graded badge, roast, and suggested rewrite.

JSON: `--json` emits a stable shape suitable for piping into other tools:

```json
{
  "version": "0.1.0",
  "persona": "linus",
  "commits": [
    {
      "sha": "abcdef1234567890",
      "shortSha": "abcdef1",
      "subject": "fix: stop the bleeding",
      "grade": "B",
      "score": 80,
      "reasons": ["could be more specific"],
      "roast": "...",
      "rewrite": "fix(io): close socket on error",
      "source": "llm"
    }
  ]
}
```

Color is auto-disabled when `--no-color` is passed or `NO_COLOR` is set in the environment ([no-color.org](https://no-color.org)).

## CI usage (`--strict` / `--quiet`)

Use `--strict` to turn commit-roast into a commit-message linter. The grader is rule-based and needs no API key, so it's free to run in CI.

```bash
# Roast only the new commits on this branch; fail the job if any are worse than C.
commit-roast --since origin/main --strict --quiet --no-color

# Pick your own threshold (A is brutal, F is basically off).
commit-roast --since origin/main --strict=B --quiet
```

- `--quiet` prints one summary line per commit (`grade  sha  subject  reasons`) and skips the roast/rewrite body and any LLM calls.
- `--strict[=<grade>]` defaults to `C`. Exits `1` if any commit grades worse than the threshold, `0` otherwise.
- `--json` adds a per-commit `failedThreshold: true|false` field when `--strict` is active, so you can post-process in scripts.

### GitHub Actions snippet

```yaml
name: commit-roast
on:
  pull_request:

jobs:
  roast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # need full history for --since origin/main
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx -y commit-roast --since origin/${{ github.base_ref }} --strict --quiet --no-color
```

## Diff-aware roasts (`--diff`)

By default the LLM only sees the commit *subject* and body. With `--diff` it also receives a truncated unified diff, which lets the persona ground its critique in what actually changed ("you called this `fix:` but you added 400 lines of new code").

```bash
commit-roast --count 5 --diff             # ~4KB diff per commit (default cap)
commit-roast --count 5 --diff --diff-bytes 8192
```

- Off by default — diffs are not cheap in tokens.
- Each diff is capped (default 4096 bytes) and cut at file boundaries, with a `… (truncated)` marker when content was dropped.
- Binary files and lockfile-heavy paths (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `*.lock`, `go.sum`, …) are skipped automatically.
- `--json` adds `diffIncluded: true|false` and `diffBytes: <n>` per commit.
- Ignored under `--quiet` (no LLM call happens in CI mode).

## LLM roasts (optional)

Set a few env vars to enable real persona-driven roasts via any OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, vLLM, …):

```bash
export ROAST_API_KEY=sk-...            # required to leave fallback mode
export ROAST_API_BASE=https://api.openai.com/v1   # default
export ROAST_MODEL=gpt-4o-mini          # default
```

If `ROAST_API_KEY` is unset, commit-roast prints canned per-persona roasts and a basic Conventional-Commits rewrite.

## Local models (`--preset`)

Local OpenAI-compatible servers (Ollama, LM Studio, llama.cpp) ship with predictable URLs. Skip the env-var dance — pick a preset:

```bash
# Use Ollama with its preset default model (qwen2.5-coder)
commit-roast --preset ollama --count 5

# Same, but override the model just for this run
commit-roast --preset ollama:llama3.1:8b

# LM Studio on the default port
commit-roast --preset lmstudio

# llama.cpp server
commit-roast --preset llamacpp

# List built-in presets
commit-roast presets list
```

Precedence (per field): `--model` / `--api-base` flags > `--preset` (incl. `:model` suffix) > `ROAST_MODEL` / `ROAST_API_BASE` env > `~/.commit-roastrc` > built-in defaults. Most local servers ignore `ROAST_API_KEY`; OpenAI requires it. If the preset's target isn't reachable, commit-roast prints a one-line hint (e.g. `ollama serve`) and falls back to offline roasts — it never blocks.

## Configuration

`commit-roast` looks for `~/.commit-roastrc` (JSON) and uses it as the source of non-secret defaults. CLI flags override the rc file; env vars always win for secrets.

```json
{
  "persona": "bard",
  "count": 3,
  "model": "qwen2.5-coder",
  "apiBase": "http://localhost:11434/v1"
}
```

Resolution order (lowest → highest): built-in defaults → `~/.commit-roastrc` → CLI flags → environment variables. A malformed rc file is ignored with a warning; it will never brick the CLI.

## Personas

Ships with four personas, each a distinct voice:

| Name      | Vibe                                                                 |
| --------- | -------------------------------------------------------------------- |
| `linus`   | Blunt kernel maintainer energy. Brevity over politeness.             |
| `pm`      | Passive-aggressive PM. "Just flagging… 👍" while twisting the knife. |
| `bard`    | Shakespearean. Treats every typo as a tragedy in five acts.          |
| `teacher` | Disappointed high-school English teacher. Red-pen energy.            |

### Writing your own persona

Personas live in [`src/personas/*.md`](./src/personas) as Markdown files with a small YAML frontmatter block. Adding a persona = adding a `.md` file.

```markdown
---
name: drillsergeant
style: Old-school drill instructor. ALL CAPS. Push-up references mandatory.
temperature: 0.9
---

You are a drill sergeant reviewing a recruit's git commit message. Use ALL CAPS for
emphasis. Reference push-ups. Two or three sentences. End by assigning extra duty.
```

Then: `commit-roast --persona drillsergeant`. Frontmatter fields:

- **name** — lowercased identifier shown in output.
- **style** — short tagline; used in docs / future `--list-personas` output.
- **temperature** — sampling temperature (0.0–1.0). Higher = wilder roasts.

The rest of the file is the system prompt sent to the LLM. Keep it short — the model has to leave room for the JSON reply (`{"roast":"…","rewrite":"…"}`).

### Adding personas from GitHub or a file

User-installed personas live in `~/.commit-roast/personas/` and override built-ins on name collisions.

```bash
# Install from a GitHub repo (default branch)
commit-roast personas add gh:rwrife/commit-roast-personas/drill-sergeant.md

# Pin to a ref (branch, tag, or sha)
commit-roast personas add gh:rwrife/commit-roast-personas@v1.0.0/drill-sergeant.md

# Or from any raw URL
commit-roast personas add https://example.com/personas/sassy.md

# Or from a local file (great for team-shared personas in a repo)
commit-roast personas add ./team-personas/lead.md

# See what's installed
commit-roast personas list

# Remove a user-installed persona (built-ins can't be removed)
commit-roast personas remove drill-sergeant
```

Personas are validated against the frontmatter schema (`name` and `style` required, `temperature` must be numeric if present) before being written to disk — malformed files are rejected with a clear error.

## Rewriting commits in place

Once you've seen a roast you actually agree with, `commit-roast rewrite <sha>` will hand
you the exact git command to apply the suggested subject:

```bash
commit-roast rewrite HEAD          # offers to run `git commit --amend` for you
commit-roast rewrite abc1234       # prints a `git rebase --exec` script you run yourself
commit-roast rewrite HEAD --yes    # skip the confirmation prompt
commit-roast rewrite HEAD --force  # allow a dirty working tree
```

Rules of the road:

- A dirty working tree is refused by default. Pass `--force` if you really mean it.
- For HEAD, commit-roast can call `git commit --amend` after you confirm.
- For older commits, commit-roast will **never** run `git rebase` for you. It prints a
  one-liner you can review and run yourself.
- Rewriting history changes commit SHAs. If you've already pushed the affected commits
  to a shared branch, coordinate with collaborators and use `git push --force-with-lease`
  (never plain `--force`).

## One-shot setup

```bash
commit-roast init                          # install hook + cheatsheet + .commit-roastrc
commit-roast init --persona pm             # bake a persona into the rc file
commit-roast init --no-hook                # rc + cheatsheet only
commit-roast init --no-cheatsheet          # rc + hook only
commit-roast init --force                  # overwrite existing rc/cheatsheet/hook
```

`init` is idempotent — re-running it on a configured repo prints a clear skip line per artifact instead of clobbering anything. Existing non-commit-roast hooks are left alone unless you pass `--force` (which moves them to `<hook>.bak`).

## Git hook

Wire commit-roast into git so every commit gets graded as you make it:

```bash
commit-roast hook install               # prepare-commit-msg (default)
commit-roast hook install --type commit-msg
commit-roast hook status                # show what's installed
commit-roast hook uninstall             # remove it (restores any .bak)
```

- `prepare-commit-msg` writes the grade + reasons into your editor as `#`-comment lines (git strips them before recording the commit) and prints them to stderr.
- `commit-msg` prints feedback to stderr only — useful with `git commit -m "..."`.
- The hook only runs the deterministic rule-based grader so it never blocks or slows down a commit, and never calls an LLM.
- Merge / squash / amended-via-`--no-edit` commits are skipped automatically.
- If a hook already exists, install refuses unless you pass `--force` (which moves the existing one to `<hook>.bak`).
- `core.hooksPath` and git worktrees are respected.

## Stats / streak mode

```bash
commit-roast stats              # last 20 commits, pretty output
commit-roast stats --count 50   # widen the window
commit-roast stats --since v1.0 # everything since a ref
commit-roast stats --json       # machine-readable
```

No LLM calls — purely the rule-based grader. You get:

- **Average score + letter grade** across the window
- **Trend sparkline** (oldest → newest), so a downward slide is visible at a glance
- **Grade distribution** (A/B/C/D/F counts)
- **Best & worst** commit in the window, with subject and SHA
- **Per-author breakdown** when more than one author shows up — useful in team repos

## Team mode (roast a PR)

Roast every commit on a GitHub PR and post a single rolled-up comment back to the PR — grades, roasts, and suggested rewrites in one Markdown table.

```bash
commit-roast team https://github.com/owner/repo/pull/42           # post a comment
commit-roast team owner/repo#42 --persona pm                       # shorthand + persona
commit-roast team owner/repo#42 --dry-run                          # print the Markdown, don't post
commit-roast team owner/repo#42 --json                             # machine-readable
```

Requires the [`gh` CLI](https://cli.github.com/) on your `PATH` and authenticated (`gh auth login`) with permission to comment on the target repo. Falls back to canned offline roasts when `ROAST_API_KEY` isn't set, just like the main command.

## MCP server

Expose `roast`, `grade`, and `rewrite` to MCP-capable clients (Claude Desktop, Cursor, OpenClaw, etc) over stdio:

```bash
commit-roast mcp
```

The server registers three tools:

| Tool      | Input                                  | What it does                                                                       |
| --------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `roast`   | `subject`, optional `body`, `persona`  | Grades + roasts a commit message; returns the Conventional Commits rewrite.        |
| `grade`   | `subject`, optional `body`             | Deterministic, offline rubric score (letter grade + reasons). No LLM call.         |
| `rewrite` | `sha`, optional `force`                | Builds a rewrite plan for a real commit in the current repo. Does NOT run anything. |

Example Claude Desktop / Cursor config snippet:

```json
{
  "mcpServers": {
    "commit-roast": {
      "command": "commit-roast",
      "args": ["mcp"],
      "env": {
        "ROAST_API_KEY": "sk-...",
        "ROAST_MODEL": "gpt-4o-mini"
      }
    }
  }
}
```

The server writes a one-line banner to **stderr** and uses **stdout** for the MCP transport — don't pipe stdout anywhere else.


## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io/) (the repo uses `pnpm` but `npm` works too)

## Scripts

| Command       | What it does                          |
| ------------- | ------------------------------------- |
| `pnpm build`  | Compile `src/bin.ts` to `dist/` via `tsup` |
| `pnpm test`   | Run the `vitest` suite once          |
| `pnpm start`  | Run the compiled CLI                 |

## License

MIT
