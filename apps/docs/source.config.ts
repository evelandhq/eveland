import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// The documentation content is single-sourced from the repository-root docs/
// tree so the same files are readable on GitHub and rendered on eveland.ai.
export const docs = defineDocs({
  dir: "../../docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig();
