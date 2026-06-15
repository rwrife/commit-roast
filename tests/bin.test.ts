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
});
