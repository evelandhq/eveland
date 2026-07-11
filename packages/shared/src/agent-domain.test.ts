import { describe, expect, test } from "vitest";
import {
  createSlugSuffix,
  isValidProjectSlug,
  mintAgentUrl,
  normalizeAgentDomain,
  slugifyProjectName,
} from "./agent-domain.js";

describe("slugifyProjectName", () => {
  test("lowercases and collapses non-alphanumerics to single hyphens", () => {
    expect(slugifyProjectName("Weather  Agent 2.0")).toBe("weather-agent-2-0");
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugifyProjectName("--My Agent--")).toBe("my-agent");
  });

  test("truncates to 40 chars without a trailing hyphen", () => {
    const slug = slugifyProjectName("a".repeat(39) + " tail");
    expect(slug).toBe("a".repeat(39));
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  test("falls back to 'agent' when nothing slugifiable remains", () => {
    expect(slugifyProjectName("你好世界")).toBe("agent");
    expect(slugifyProjectName("!!!")).toBe("agent");
  });
});

describe("isValidProjectSlug", () => {
  test.each(["my-agent", "a", "a1", "agent-2", "x".repeat(63)])("accepts %s", (slug) => {
    expect(isValidProjectSlug(slug)).toBe(true);
  });

  test.each(["-agent", "agent-", "My-Agent", "a_b", "a.b", "", "x".repeat(64)])("rejects %s", (slug) => {
    expect(isValidProjectSlug(slug)).toBe(false);
  });

  test.each(["www", "api", "gateway", "eveland", "admin"])("rejects reserved slug %s", (slug) => {
    expect(isValidProjectSlug(slug)).toBe(false);
  });
});

describe("createSlugSuffix", () => {
  test("returns 4 lowercase-alphanumeric chars", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(createSlugSuffix()).toMatch(/^[0-9a-z]{4}$/);
    }
  });
});

describe("normalizeAgentDomain", () => {
  test("lowercases, trims, and strips a trailing dot", () => {
    expect(normalizeAgentDomain(" LVH.me. ")).toBe("lvh.me");
  });

  test("returns null for unset or blank values", () => {
    expect(normalizeAgentDomain(undefined)).toBeNull();
    expect(normalizeAgentDomain("  ")).toBeNull();
  });
});

describe("mintAgentUrl", () => {
  test("mints scheme://slug.domain with optional port", () => {
    expect(mintAgentUrl("demo", { EVELAND_AGENT_DOMAIN: "lvh.me", EVELAND_AGENT_URL_SCHEME: "http", EVELAND_AGENT_URL_PORT: "8080" })).toBe(
      "http://demo.lvh.me:8080",
    );
    expect(mintAgentUrl("demo", { EVELAND_AGENT_DOMAIN: "jinshujuagents.com", EVELAND_AGENT_URL_SCHEME: "https" })).toBe(
      "https://demo.jinshujuagents.com",
    );
  });

  test("defaults the scheme to http", () => {
    expect(mintAgentUrl("demo", { EVELAND_AGENT_DOMAIN: "lvh.me" })).toBe("http://demo.lvh.me");
  });

  test("returns null when the domain is not configured", () => {
    expect(mintAgentUrl("demo", {})).toBeNull();
  });
});
