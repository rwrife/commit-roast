import { Command } from "commander";
import { VERSION } from "./version.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("commit-roast")
    .description(
      "Roast your last N git commits with swappable AI personas. Equal parts dev-tool and dunk-tank."
    )
    .version(VERSION, "-v, --version", "print version")
    .option("-c, --count <n>", "number of commits to roast", "5")
    .option("-p, --persona <name>", "persona to use", "linus")
    .option("--no-color", "disable colored output")
    .action((opts) => {
      // M1: hello-world only. Real implementation lands in M2+.
      const count = Number(opts.count) || 5;
      const persona = String(opts.persona);
      // eslint-disable-next-line no-console
      console.log(
        `commit-roast v${VERSION} — would roast ${count} commit(s) as "${persona}". (scaffold; real roasting lands in M2+)`
      );
    });

  return program;
}

export function run(argv: string[] = process.argv): void {
  buildProgram().parse(argv);
}

// Run when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /commit-roast|bin\.(js|ts|mjs|cjs)$/.test(process.argv[1] ?? "");

if (invokedDirectly) {
  run();
}
