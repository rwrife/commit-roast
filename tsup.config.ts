import { defineConfig } from "tsup";

export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  clean: true,
  sourcemap: false,
  splitting: false,
  shims: false,
  banner: { js: "#!/usr/bin/env node" },
});
