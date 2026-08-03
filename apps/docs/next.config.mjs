import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

export default withMDX({
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/docs/quick-start", destination: "/docs/production", permanent: true },
      { source: "/docs/concepts", destination: "/docs/agents/releases-routing", permanent: true },
      { source: "/docs/deploy", destination: "/docs/agents/first-deployment", permanent: true },
      { source: "/docs/operate", destination: "/docs/operations/runtime", permanent: true },
      {
        source: "/docs/architecture",
        destination: "/docs/reference/architecture",
        permanent: true,
      },
      {
        source: "/docs/troubleshooting",
        destination: "/docs/reference/troubleshooting",
        permanent: true,
      },
      { source: "/zh/docs/quick-start", destination: "/zh/docs/production", permanent: true },
      {
        source: "/zh/docs/concepts",
        destination: "/zh/docs/agents/releases-routing",
        permanent: true,
      },
      {
        source: "/zh/docs/deploy",
        destination: "/zh/docs/agents/first-deployment",
        permanent: true,
      },
      { source: "/zh/docs/operate", destination: "/zh/docs/operations/runtime", permanent: true },
      {
        source: "/zh/docs/architecture",
        destination: "/zh/docs/reference/architecture",
        permanent: true,
      },
      {
        source: "/zh/docs/troubleshooting",
        destination: "/zh/docs/reference/troubleshooting",
        permanent: true,
      },
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
