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

## LLM roasts (optional)

Set a few env vars to enable real persona-driven roasts via any OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, vLLM, …):

```bash
export ROAST_API_KEY=sk-...            # required to leave fallback mode
export ROAST_API_BASE=https://api.openai.com/v1   # default
export ROAST_MODEL=gpt-4o-mini          # default
```

If `ROAST_API_KEY` is unset, commit-roast prints canned per-persona roasts and a basic Conventional-Commits rewrite.

## Personas

Personas live in [`src/personas/*.md`](./src/personas) as Markdown files with a small YAML frontmatter block (`name`, `style`, `temperature`). Adding a persona = adding a `.md` file. Ships with `linus`, `pm`, `bard`, `teacher`.

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
