import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Component tests get a DOM by declaring `// @vitest-environment jsdom` in
// their docblock; everything else (pure transforms, repo-wide rule scans)
// stays on the faster default node environment.
export default defineConfig({
  esbuild: {
    // Next compiles JSX with the automatic runtime; vitest transforms these
    // files itself and needs the same setting or `React` is undefined.
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
