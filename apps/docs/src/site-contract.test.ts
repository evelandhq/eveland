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

    expect(packageJson).toContain('"name": "@evelandhq/docs"');
    expect(packageJson).toContain("next build");
    expect(source("../next.config.mjs")).toContain("createMDX");
    expect(source("../source.config.ts")).toContain('dir: "../../docs"');
  });

  test("targets eveland.ai as a static Workers Assets site", () => {
    const packageJson = source("../package.json");
    const wrangler = source("../wrangler.jsonc");

    expect(packageJson).toContain('"build:cloudflare": "pnpm generate:llm-pages && next build"');
    expect(packageJson).toContain('"wrangler"');
    expect(packageJson).not.toContain("opennextjs");
    expect(wrangler).toContain('"name": "eveland-docs"');
    expect(wrangler).not.toContain('"main"');
    expect(wrangler).toContain('"directory": "out"');
    expect(wrangler).toContain('"not_found_handling": "404-page"');
    expect(wrangler).toContain('"pattern": "eveland.ai"');
    expect(wrangler).toContain('"custom_domain": true');
    expect(source("../public/_headers")).toContain("/_next/static/*");
    expect(source("../next.config.mjs")).toContain('output: "export"');
  });

  test("exports English at the root and only 301s legacy /en URLs", () => {
    const redirects = source("../public/_redirects");

    expect(redirects).toContain("/en / 301");
    expect(redirects).toContain("/en/docs /docs 301");
    expect(redirects).toContain("/en/docs/* /docs/:splat 301");
    // Never serve /en content on prefix-less URLs via 200 rewrites: the
    // exported HTML embeds its own path and hydration breaks (React #418).
    expect(redirects).not.toContain(" 200");
    expect(source("../src/app/api/search/route.ts")).toContain("staticGET");
  });

  test("deploys docs changes pushed to main", () => {
    const workflow = source("../../../.github/workflows/deploy-docs.yml");

    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("- apps/docs/**");
    expect(workflow).toContain("- docs/**");
    expect(workflow).toContain("pnpm --filter @evelandhq/docs build:cloudflare");
    expect(workflow).toMatch(/cloudflare\/wrangler-action@[0-9a-f]{40} # v4/);
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("apps/docs/.next/cache");
    expect(workflow).toContain("key: ${{ runner.os }}-next-docs-");
  });

  test("runs every workflow on the current Node 24 action runtime", () => {
    for (const workflow of ["ci.yml", "deploy-docs.yml", "systemd-smoke.yml"]) {
      const sourceText = source(`../../../.github/workflows/${workflow}`);

      expect(sourceText).toContain("actions/setup-node@v7");
      expect(sourceText).not.toContain("actions/setup-node@v6");
      expect(sourceText).toContain("node-version: 24");
    }
  });

  test("runs the three slowest test packages on independent CI runners", () => {
    const workflow = source("../../../.github/workflows/ci.yml");

    expect(workflow).toContain("strategy:");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("command: pnpm --filter @evelandhq/api test");
    expect(workflow).toContain("command: pnpm --filter @evelandhq/worker test");
    expect(workflow).toContain("command: pnpm --filter @evelandhq/db test");
    expect(workflow).toContain("--filter='!@evelandhq/api'");
    expect(workflow).toContain("--filter='!@evelandhq/worker'");
    expect(workflow).toContain("--filter='!@evelandhq/db'");
  });

  test("builds only packages whose build differs from typecheck", () => {
    const workflow = source("../../../.github/workflows/ci.yml");

    expect(workflow).toContain("pnpm --filter @evelandhq/docs --filter @evelandhq/web -r build");
    expect(workflow).not.toContain("run: pnpm -r build");
  });

  test("restores isolated Next.js build caches for both applications", () => {
    const workflow = source("../../../.github/workflows/ci.yml");

    expect(workflow).toContain("apps/web/.next/cache");
    expect(workflow).toContain("apps/docs/.next/cache");
    expect(workflow).toContain("key: ${{ runner.os }}-next-web-");
    expect(workflow).toContain("key: ${{ runner.os }}-next-docs-");
  });

  test("cancels obsolete CI runs for the same branch", () => {
    const workflow = source("../../../.github/workflows/ci.yml");

    expect(workflow).toContain("group: ${{ github.workflow }}-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
  });

  test("publishes English and Chinese locale routes", () => {
    expect(source("./lib/i18n.ts")).toContain('languages: ["en", "zh"]');
    expect(source("./lib/i18n.ts")).toContain('defaultLanguage: "en"');
    expect(existsSync(path("./app/(en)/page.tsx"))).toBe(true);
    expect(existsSync(path("./app/(en)/docs/[[...slug]]/page.tsx"))).toBe(true);
    expect(existsSync(path("./app/(zh)/zh/page.tsx"))).toBe(true);
    expect(existsSync(path("./app/(zh)/zh/docs/[[...slug]]/page.tsx"))).toBe(true);
  });

  test("localizes the documentation chrome and production diagrams", () => {
    const layout = source("./lib/layout.shared.tsx");

    expect(layout).toContain('search: "搜索"');
    expect(layout).toContain('toc: "本页内容"');
    expect(layout).toContain('nextPage: "下一页"');
    expect(existsSync(path("../../../docs/assets/topology-en.svg"))).toBe(true);
    expect(existsSync(path("../../../docs/assets/topology-zh.svg"))).toBe(true);
    expect(source("../../../docs/en/production/index.md")).toContain(
      "](../../assets/topology-en.svg)",
    );
    expect(source("../../../docs/zh/production/index.md")).toContain(
      "](../../assets/topology-zh.svg)",
    );
  });

  test("keeps English URLs clean and prefixes only Chinese URLs", () => {
    expect(source("./lib/i18n.ts")).toContain('hideLocale: "default-locale"');
    expect(source("./lib/urls.ts")).toContain(
      'return lang === "en" ? normalizedPath : `/zh${normalizedPath}`',
    );
    expect(source("./lib/site-copy.ts")).not.toContain('"/en/');
    expect(source("../../../docs/en/index.md")).not.toContain("/en/");
    expect(source("./app/sitemap.ts")).not.toContain("${siteUrl}/en");
  });

  test("publishes the production-first documentation architecture in both languages", () => {
    const requiredPages = [
      "index.md",
      "production/index.md",
      "production/prerequisites.md",
      "production/core-services.md",
      "production/worker.md",
      "production/workflow-dispatcher.md",
      "production/networking.md",
      "production/verify.md",
      "agents/first-deployment.md",
      "agents/secrets-connections.md",
      "agents/releases-routing.md",
      "observe/sessions.md",
      "observe/schedules.md",
      "operations/runtime.md",
      "operations/capacity.md",
      "operations/diagnostics.md",
      "operations/upgrades.md",
      "operations/backup-restore.md",
      "operations/security.md",
      "reference/configuration.md",
      "reference/environment-variables.md",
      "reference/eve-compatibility.md",
      "reference/architecture.md",
      "reference/identity.md",
      "reference/source-import.md",
      "reference/playground.md",
      "reference/scheduling.md",
      "reference/agent-environment.md",
      "reference/dashboard.md",
      "reference/routing.md",
      "reference/observability.md",
      "reference/troubleshooting.md",
    ];

    for (const locale of ["en", "zh"]) {
      for (const page of requiredPages) {
        expect(existsSync(path(`../../../docs/${locale}/${page}`))).toBe(true);
      }
      const navigation = source(`../../../docs/${locale}/meta.json`);
      expect(navigation).toContain('"production"');
      expect(navigation).toContain('"agents"');
      expect(navigation).toContain('"observe"');
      expect(navigation).toContain('"operations"');
      expect(navigation).toContain('"reference"');
    }
  });

  test("makes production deployment the primary homepage journey", () => {
    const page = source("./components/home-page.tsx");
    const copy = source("./lib/site-copy.ts");

    expect(page).toContain("<DeploymentFlow");
    expect(page).toContain("productionHref");
    expect(page).toContain("github.com/evelandhq/eveland");
    expect(copy).toContain('href: "/docs/production"');
    expect(copy).toContain('href: "/zh/docs/production"');
    expect(copy).toContain("systemd");
  });

  test("mirrors the Eve documentation shell with the system font stack", () => {
    const globalStyles = source("./app/global.css");
    const docsStyles = source("./app/documentation.css");
    const docsLayout = source("./components/docs-shell.tsx");
    const docsHeader = source("./components/docs-header.tsx");

    expect(docsLayout).toContain("<DocsHeader");
    expect(docsLayout).toContain('className: "eve-docs-container"');
    expect(docsLayout).toContain('"--fd-docs-row-1": "4rem"');
    expect(docsHeader).toContain('className="eve-docs-header"');
    expect(docsHeader).toContain("FullSearchTrigger");
    expect(docsHeader).not.toContain('import { Github } from "lucide-react"');
    expect(docsHeader).toContain('viewBox="0 0 24 24"');
    expect(docsStyles).toContain("--eve-docs-background: oklch(0.984 0 0)");
    expect(docsStyles).toContain("--fd-layout-width: 90.5rem");
    expect(docsStyles).toContain("--fd-sidebar-width: 18.75rem");
    expect(docsStyles).toContain("#nd-page > h1");
    expect(docsStyles).toContain("#nd-toc");
    expect(docsStyles).toMatch(/\.docs-shell \.prose figure:has\(pre\) pre \{[^}]*border: 0;/s);
    expect(docsStyles).toContain("#nd-subnav [data-search]");
    expect(docsStyles).toContain("[data-toc-popover]");
    expect(docsStyles).toContain('button[aria-label="Open Sidebar"]::after');
    expect(docsStyles).toContain('button[aria-label="打开侧边栏"]::after');
    expect(globalStyles).toContain('-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto');
    expect(globalStyles).toContain('@import "./documentation.css"');
  });

  test("ships discovery endpoints for people, search engines, and agents", () => {
    expect(existsSync(path("./app/robots.ts"))).toBe(true);
    expect(existsSync(path("./app/sitemap.ts"))).toBe(true);
    expect(existsSync(path("./app/llms.txt/route.ts"))).toBe(true);
    expect(existsSync(path("./app/api/search/route.ts"))).toBe(true);
  });

  test("shows Fumadocs page actions for every localized document", () => {
    const page = source("./components/docs-slug-page.tsx");

    expect(page).toContain("MarkdownCopyButton");
    expect(page).toContain("ViewOptionsPopover");
    expect(page).toContain("`${page.url}.md`");
    expect(page).toContain("https://github.com/evelandhq/eveland/blob/main/docs/${page.path}");
    expect(page).toContain('className="eve-docs-page-actions"');
  });

  test("builds localized page-action Markdown as Worker-free static assets", () => {
    const packageJson = source("../package.json");
    const generator = source("../scripts/generate-llm-pages.mjs");

    expect(packageJson).toContain('"generate:llm-pages": "node scripts/generate-llm-pages.mjs"');
    expect(packageJson).toContain('"build": "pnpm generate:llm-pages && next build"');
    expect(packageJson).toContain('"build:cloudflare": "pnpm generate:llm-pages && next build"');
    expect(generator).toContain('from "fumadocs-core/content/md/frontmatter"');
    expect(generator).toContain("export async function generateLlmPages");
    expect(generator).toContain("# ${title} (${pageUrl})");
  });

  test("publishes clean English and prefixed Chinese Markdown as direct static assets", () => {
    const generator = source("../scripts/generate-llm-pages.mjs");

    expect(generator).toContain('join(publicDirectory, "docs.md")');
    expect(generator).toContain('join(publicDirectory, "docs")');
    expect(generator).toContain('join(publicDirectory, "zh", "docs.md")');
    expect(generator).toContain('join(publicDirectory, "zh", "docs")');
  });

  test("does not nest the brand link inside the docs navigation link", () => {
    expect(source("./lib/layout.shared.tsx")).toContain("<Brand lang={lang} linked={false}");
    expect(source("./components/brand.tsx")).toContain("linked = true");
  });

  test("declares smooth scrolling and provides a site icon", () => {
    expect(source("./components/locale-shell.tsx")).toContain('data-scroll-behavior="smooth"');
    expect(existsSync(path("./app/icon.svg"))).toBe(true);
  });
});
