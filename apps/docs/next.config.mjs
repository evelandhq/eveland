import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// The site is fully static: `output: "export"` emits plain files served by
// Cloudflare Workers Assets, so there is no server bundle to hit the Worker
// size limit. The en-at-root URL scheme (formerly Next redirects/rewrites)
// lives in public/_redirects, which Workers Assets evaluates at the edge.
export default withMDX({
  reactStrictMode: true,
  output: "export",
});
