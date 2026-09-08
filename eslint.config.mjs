import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores(["node_modules/**", ".build/**", "release/**", "optimizer/**", "scripts/**", "tests/**", "main.js", "esbuild.config.mjs", "eslint.config.mjs"]),
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { acronyms: ["FSRS", "JSON", "CSV", "YAML", "CSS", "HTML", "PDF", "WASM", "ID", "API", "URL"] }],
    },
  },
]);
