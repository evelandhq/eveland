import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// The site is fully static: `output: "export"` emits plain files served by
// Cloudflare Workers Assets, so there is no server bundle to hit the Worker
// size limit. English routes live at the root of the app directory (route
// group "(en)") and Chinese under /zh, so the export needs no URL rewriting;
// public/_redirects only 301s legacy /en/* URLs.
export default withMDX({
  reactStrictMode: true,
  output: "export",
});
