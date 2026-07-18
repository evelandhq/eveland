import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function path(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

function source(relativePath: string): string {
  const target = path(relativePath);
  return existsSync(target) ? readFileSync(target, "utf8") : "";
}

describe("Eveland public website contract", () => {
  test("is an independent Next.js application in the monorepo", () => {
    const packageJson = source("../package.json");

    expect(packageJson).toContain('"name": "@eveland/docs"');
    expect(packageJson).toContain('"build": "next build"');
    expect(source("../next.config.mjs")).toContain("createMDX");
  });

  test("targets the eveland.ai Cloudflare Worker", () => {
    const packageJson = source("../package.json");
    const wrangler = source("../wrangler.jsonc");

    expect(packageJson).toContain('"build:cloudflare": "opennextjs-cloudflare build"');
    expect(packageJson).toContain('"deploy:cloudflare": "opennextjs-cloudflare deploy"');
    expect(packageJson).toContain('"@opennextjs/cloudflare"');
    expect(packageJson).toContain('"wrangler"');
    expect(wrangler).toContain('"name": "eveland-docs"');
    expect(wrangler).toContain('"main": ".open-next/worker.js"');
    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain('"directory": ".open-next/assets"');
    expect(wrangler).toContain('"pattern": "eveland.ai"');
    expect(wrangler).toContain('"custom_domain": true');
    expect(source("../open-next.config.ts")).toContain("defineCloudflareConfig");
    expect(source("../public/_headers")).toContain("/_next/static/*");
    expect(source("../next.config.mjs")).toContain("async rewrites()");
    expect(source("../next.config.mjs")).toContain('destination: "/en/docs/:path*"');
  });

  test("deploys docs changes pushed to main", () => {
    const workflow = source("../../../.github/workflows/deploy-docs.yml");

    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("- apps/docs/**");
    expect(workflow).toContain("pnpm --filter @eveland/docs build:cloudflare");
    expect(workflow).toContain("cloudflare/wrangler-action@v3");
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("publishes English and Chinese locale routes", () => {
    expect(source("./lib/i18n.ts")).toContain("languages: ['en', 'zh']");
    expect(source("./lib/i18n.ts")).toContain("defaultLanguage: 'en'");
    expect(existsSync(path("./app/[lang]/page.tsx"))).toBe(true);
    expect(existsSync(path("./app/[lang]/docs/[[...slug]]/page.tsx"))).toBe(true);
  });

  test("localizes the documentation chrome and production diagrams", () => {
    const layout = source("./lib/layout.shared.tsx");
    const topology = source("./components/runtime-topology.tsx");

    expect(layout).toContain('search: "搜索"');
    expect(layout).toContain('toc: "本页内容"');
    expect(layout).toContain('nextPage: "下一页"');
    expect(topology).toContain("lang?: Language");
    expect(source("../content/docs/en/production/index.mdx")).toContain(
      '<RuntimeTopology lang="en" />',
    );
    expect(source("../content/docs/zh/production/index.mdx")).toContain(
      '<RuntimeTopology lang="zh" />',
    );
  });

  test("keeps English URLs clean and prefixes only Chinese URLs", () => {
    expect(source("./lib/i18n.ts")).toContain("hideLocale: 'default-locale'");
    expect(source("./lib/urls.ts")).toContain(
      'return lang === "en" ? normalizedPath : `/zh${normalizedPath}`',
    );
    expect(source("./lib/site-copy.ts")).not.toContain('"/en/');
    expect(source("../content/docs/en/index.mdx")).not.toContain("/en/");
    expect(source("../content/docs/en/quick-start.mdx")).not.toContain("/en/");
    expect(source("./app/sitemap.ts")).not.toContain("${siteUrl}/en");
  });

  test("publishes the production-first documentation architecture in both languages", () => {
    const requiredPages = [
      "index.mdx",
      "production/index.mdx",
      "production/prerequisites.mdx",
      "production/control-plane.mdx",
      "production/worker.mdx",
      "production/networking.mdx",
      "production/verify.mdx",
      "agents/first-deployment.mdx",
      "agents/secrets-connections.mdx",
      "agents/releases-routing.mdx",
      "observe/sessions.mdx",
      "observe/schedules.mdx",
      "operations/runtime.mdx",
      "operations/diagnostics.mdx",
      "operations/upgrades.mdx",
      "operations/security.mdx",
      "reference/configuration.mdx",
      "reference/eve-compatibility.mdx",
      "reference/architecture.mdx",
      "reference/troubleshooting.mdx",
    ];

    for (const locale of ["en", "zh"]) {
      for (const page of requiredPages) {
        expect(existsSync(path(`../content/docs/${locale}/${page}`))).toBe(true);
      }
      const navigation = source(`../content/docs/${locale}/meta.json`);
      expect(navigation).toContain('"production"');
      expect(navigation).toContain('"agents"');
      expect(navigation).toContain('"observe"');
      expect(navigation).toContain('"operations"');
      expect(navigation).toContain('"reference"');
    }
  });

  test("makes production deployment the primary homepage journey", () => {
    const page = source("./app/[lang]/page.tsx");
    const copy = source("./lib/site-copy.ts");

    expect(page).toContain("<RuntimeStage");
    expect(page).toContain("<DeploymentFlow");
    expect(page).toContain("productionHref");
    expect(page).toContain("github.com/evelandhq/eveland");
    expect(copy).toContain('href: "/docs/production"');
    expect(copy).toContain('href: "/zh/docs/production"');
    expect(copy).toContain("systemd");
    expect(copy).toContain("按需唤醒");
  });

  test("redirects the former flat documentation URLs into the new structure", () => {
    const config = source("../next.config.mjs");

    expect(config).toContain('source: "/docs/quick-start"');
    expect(config).toContain('destination: "/docs/production"');
    expect(config).toContain('source: "/docs/deploy"');
    expect(config).toContain('destination: "/docs/agents/first-deployment"');
    expect(config).toContain('source: "/zh/docs/operate"');
    expect(config).toContain('destination: "/zh/docs/operations/runtime"');
  });

  test("uses the light editorial visual system across the homepage and docs", () => {
    const page = source("./app/[lang]/page.tsx");
    const stage = source("./components/runtime-stage.tsx");
    const globalStyles = source("./app/global.css");
    const styles = [
      globalStyles,
      source("./app/marketing.css"),
      source("./app/documentation.css"),
      source("./app/responsive.css"),
    ].join("\n");

    expect(page).toContain("<RuntimeStage");
    expect(existsSync(path("./components/runtime-stage.tsx"))).toBe(true);
    expect(stage).toContain('className="runtime-stage"');
    expect(stage).toContain('className="topology-plane"');
    expect(stage).toContain('className="topology-runtime"');
    expect(styles).toContain("--accent: #ff5c35");
    expect(styles).toContain("--fd-background: #ffffff");
    expect(styles).toContain(".docs-shell");
    expect(globalStyles).toContain('@import "./documentation.css"');
  });

  test("ships discovery endpoints for people, search engines, and agents", () => {
    expect(existsSync(path("./app/robots.ts"))).toBe(true);
    expect(existsSync(path("./app/sitemap.ts"))).toBe(true);
    expect(existsSync(path("./app/llms.txt/route.ts"))).toBe(true);
    expect(existsSync(path("./app/api/search/route.ts"))).toBe(true);
  });

  test("does not nest the brand link inside the docs navigation link", () => {
    expect(source("./lib/layout.shared.tsx")).toContain("<Brand lang={lang} linked={false}");
    expect(source("./components/brand.tsx")).toContain("linked = true");
  });

  test("declares smooth scrolling and provides a site icon", () => {
    expect(source("./app/[lang]/layout.tsx")).toContain('data-scroll-behavior="smooth"');
    expect(existsSync(path("./app/icon.svg"))).toBe(true);
  });
});
