import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

export default withMDX({
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/en", destination: "/", permanent: true },
      { source: "/en/docs", destination: "/docs", permanent: true },
      { source: "/en/docs/:path*", destination: "/docs/:path*", permanent: true },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/en" },
        { source: "/docs", destination: "/en/docs" },
        { source: "/docs/:path*", destination: "/en/docs/:path*" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
});
