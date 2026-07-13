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

  test("publishes English and Chinese locale routes", () => {
    expect(source("./lib/i18n.ts")).toContain("languages: ['en', 'zh']");
    expect(source("./lib/i18n.ts")).toContain("defaultLanguage: 'en'");
    expect(existsSync(path("./app/[lang]/page.tsx"))).toBe(true);
    expect(existsSync(path("./app/[lang]/docs/[[...slug]]/page.tsx"))).toBe(true);
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

  test("keeps equivalent public documentation in both languages", () => {
    const requiredPages = [
      "index.mdx",
      "quick-start.mdx",
      "concepts.mdx",
      "deploy.mdx",
      "operate.mdx",
      "architecture.mdx",
      "troubleshooting.mdx",
    ];

    for (const locale of ["en", "zh"]) {
      for (const page of requiredPages) {
        expect(existsSync(path(`../content/docs/${locale}/${page}`))).toBe(true);
      }
      expect(source(`../content/docs/${locale}/meta.json`)).toContain('"quick-start"');
      expect(source(`../content/docs/${locale}/meta.json`)).toContain('"architecture"');
    }
  });

  test("orients developers, agent authors, and operators from the homepage", () => {
    const page = source("./app/[lang]/page.tsx");

    expect(page).toContain("<SystemMap");
    expect(page).toContain("<AudiencePaths");
    expect(page).toContain("<DeploymentFlow");
    expect(page).toContain("getStartedHref");
    expect(page).toContain("github.com/evelandhq/eveland");
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
