import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/bin.js";
import { VERSION } from "../src/version.js";

describe("commit-roast CLI", () => {
  it("exposes the current version", () => {
    const program = buildProgram();
    expect(program.version()).toBe(VERSION);
  });

  it("leaves count/persona unset on the program so config layer can supply defaults", () => {
    const program = buildProgram();
    program.exitOverride();
    // No args — commander used to provide defaults, but defaults now live
    // in src/config.ts (resolveDefaults). The program should NOT inject them.
    program.parse(["node", "commit-roast"], { from: "user" });
    const opts = program.opts();
    expect(opts.count).toBeUndefined();
    expect(opts.persona).toBeUndefined();
  });

  it("still accepts explicit --count and --persona", () => {
    const program = buildProgram();
    program.exitOverride();
    program.parse(["node", "commit-roast", "--count", "3", "--persona", "pm"], { from: "user" });
    const opts = program.opts();
    expect(opts.count).toBe("3");
    expect(opts.persona).toBe("pm");
  });

  it("accepts --quiet and --strict flags", () => {
    const program = buildProgram();
    program.exitOverride();
    program.parse(["node", "commit-roast", "--quiet", "--strict", "B"], { from: "user" });
    const opts = program.opts();
    expect(opts.quiet).toBe(true);
    expect(opts.strict).toBe("B");
  });

  it("--strict without value resolves to boolean true (defaults to C in handler)", () => {
    const program = buildProgram();
    program.exitOverride();
    program.parse(["node", "commit-roast", "--strict"], { from: "user" });
    const opts = program.opts();
    expect(opts.strict).toBe(true);
  });

  it("accepts --battle, --side-by-side, and --judge flags", () => {
    const program = buildProgram();
    program.exitOverride();
    program.parse(
      ["node", "commit-roast", "--battle", "linus,pm", "--side-by-side", "--judge"],
      { from: "user" }
    );
    const opts = program.opts();
    expect(opts.battle).toBe("linus,pm");
    expect(opts.sideBySide).toBe(true);
    expect(opts.judge).toBe(true);
  });
});
