import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/bin.js";
import { VERSION } from "../src/version.js";

describe("commit-roast CLI", () => {
  it("exposes the current version", () => {
    const program = buildProgram();
    expect(program.version()).toBe(VERSION);
  });

  it("defaults to 5 commits and the linus persona", () => {
    const program = buildProgram();
    program.exitOverride(); // don't actually exit during tests
    // Parse with no args so commander applies defaults.
    program.parse(["node", "commit-roast"], { from: "user" });
    const opts = program.opts();
    expect(opts.count).toBe("5");
    expect(opts.persona).toBe("linus");
  });
});
