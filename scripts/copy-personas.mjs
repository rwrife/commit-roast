import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/personas", { recursive: true });
cpSync("src/personas", "dist/personas", { recursive: true });
console.log("copied personas/ → dist/personas/");
