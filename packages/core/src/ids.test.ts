import { describe, expect, test } from "vitest";
import {
  claimDeploymentKey,
  claimProjectSlug,
  createDeploymentKey,
  createId,
  idAlphabet,
  inferProjectSlugFromGitUrl,
  normalizeGitCredentialHost,
  normalizeGitHttpHost,
  slugifyProjectName,
} from "./ids.js";

describe("createId", () => {
  test("creates prefixed 10 character IDs using the approved alphabet", () => {
    const id = createId("proj");

    expect(id).toMatch(/^proj_[A-Za-z0-9]{10}$/);
    expect(Array.from(id.slice("proj_".length)).every((char) => idAlphabet.includes(char))).toBe(
      true,
    );
  });
});

describe("project slugs", () => {
  test("normalizes a repository-style name into a DNS-safe slug", () => {
    expect(slugifyProjectName("  Sample_Office Assistant.git  ")).toBe(
      "sample-office-assistant-git",
    );
    expect(slugifyProjectName("Crème brûlée agent")).toBe("creme-brulee-agent");
    expect(() => slugifyProjectName("---")).toThrow(/project name/i);
  });

  test("infers the slug from HTTPS and SCP-style Git repository URLs", () => {
    expect(
      inferProjectSlugFromGitUrl("https://github.com/evelandhq/sample-office-assistant.git"),
    ).toBe("sample-office-assistant");
    expect(inferProjectSlugFromGitUrl("git@github.com:evelandhq/sample-office-assistant.git")).toBe(
      "sample-office-assistant",
    );
  });

  test("claims the requested slug and then deterministic numeric suffixes", async () => {
    const attempted: string[] = [];

    const claimed = await claimProjectSlug("sample-office-assistant", async (candidate) => {
      attempted.push(candidate);
      return candidate === "sample-office-assistant-2" ? { slug: candidate } : null;
    });

    expect(attempted).toEqual([
      "sample-office-assistant",
      "sample-office-assistant-1",
      "sample-office-assistant-2",
    ]);
    expect(claimed).toEqual({ slug: "sample-office-assistant-2" });
  });
});

describe("Git HTTP hosts", () => {
  test("normalizes HTTPS repository hosts without accepting embedded credentials or SSH addresses", () => {
    expect(normalizeGitHttpHost(" https://GitLab.Example.COM:8443/group/agent.git ")).toBe(
      "gitlab.example.com:8443",
    );
    expect(
      normalizeGitHttpHost("https://oauth2:token@gitlab.example.com/group/agent.git"),
    ).toBeNull();
    expect(normalizeGitHttpHost("http://gitlab.example.com/group/agent.git")).toBeNull();
    expect(normalizeGitHttpHost("git@gitlab.example.com:group/agent.git")).toBeNull();
  });

  test("normalizes typed host input with an optional https prefix but no path or credentials", () => {
    expect(normalizeGitCredentialHost(" GitLab.Example.COM:8443 ")).toBe("gitlab.example.com:8443");
    expect(normalizeGitCredentialHost("https://gitlab.example.com/")).toBe("gitlab.example.com");
    expect(normalizeGitCredentialHost("gitlab.example.com/group")).toBeNull();
    expect(normalizeGitCredentialHost("http://gitlab.example.com")).toBeNull();
    expect(normalizeGitCredentialHost("oauth2:token@gitlab.example.com")).toBeNull();
    expect(normalizeGitCredentialHost("")).toBeNull();
  });
});

describe("deployment keys", () => {
  test("creates an eight-character lowercase alphanumeric public key", () => {
    expect(createDeploymentKey()).toMatch(/^[a-z0-9]{8}$/);
  });

  test("retries project-local deployment key collisions within a bounded budget", async () => {
    const candidates = ["collision", "unique01"];

    await expect(
      claimDeploymentKey(async (candidate) => (candidate === "unique01" ? candidate : null), {
        generate: () => candidates.shift()!,
      }),
    ).resolves.toBe("unique01");
  });
});
