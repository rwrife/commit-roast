# commit-roast

Roast your last N git commits with swappable AI personas — Linus, a passive-aggressive PM, Shakespeare, your high-school English teacher. Equal parts dev-tool and dunk-tank.

See [PLAN.md](./PLAN.md) for the full pitch and roadmap.

## Status

🚧 Pre-alpha. M1 scaffold is in place — the CLI runs but does not yet read git or call an LLM. Real roasting lands in M2+.

## Quick start

```bash
pnpm install
pnpm build
pnpm test

# run the CLI
node ./dist/bin.mjs --help
node ./dist/bin.mjs --version
node ./dist/bin.mjs --count 3 --persona linus
```

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
