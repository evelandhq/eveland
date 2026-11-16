import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { repoRoot } from "./scan-support.js";

/**
 * Invariants of the starter template eveland-ctl seeds as an instance's first
 * agent, which once broke real imports or would silently degrade the seeded
 * project. Its eve pin is checked with the rest of the eve window in
 * eve-compatibility-consistency.test.ts.
 */

const defaultTemplateDir = () => path.join(repoRoot, "templates/starter-agent");

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe("starter-agent template", () => {
  test("is pure text — binary files brick source import silently", async () => {
    const root = defaultTemplateDir();
    const files = await listFiles(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file, "only text extensions belong in the template").toMatch(/\.(ts|md|json)$/);
      const content = await readFile(path.join(root, file));
      expect(content.includes(0), `${file} contains a NUL byte`).toBe(false);
    }
  });

  test("has the importable nested layout with required files", async () => {
    const root = defaultTemplateDir();
    const files = await listFiles(root);
    expect(files).toContain("package.json");
    expect(files).toContain(path.join("agent", "instructions.md"));
    expect(files).toContain(path.join("agent", "agent.ts"));
    expect(files).toContain(path.join("agent", "channels", "eve.ts"));
    // Deliberate absences: the platform injects the sandbox backend, a
    // default cron schedule would spend tokens on a timer, and per-user
    // memory under the default Open identity provider would silently share
    // one memory across all public visitors (review finding on #442) — the
    // README documents how to enable it once identity is Internal/OIDC.
    expect(files.some((file) => file.startsWith(path.join("agent", "sandbox")))).toBe(false);
    expect(files.some((file) => file.startsWith(path.join("agent", "schedules")))).toBe(false);
    expect(files.some((file) => file.startsWith(path.join("agent", "memory")))).toBe(false);
  });

  // eve's own channel, so the health route and the chat surface stay, behind
  // the platform's identity plane.
  test("the eve channel authenticates through Eveland identity", async () => {
    const channel = await readFile(
      path.join(defaultTemplateDir(), "agent", "channels", "eve.ts"),
      "utf8",
    );
    expect(channel).toMatch(/from "eve\/channels\/eve"/);
    expect(channel).toContain("evelandIdentity()");
  });

  test("package.json pins the model-facing dependencies the platform expects", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(defaultTemplateDir(), "package.json"), "utf8"),
    ) as { private?: boolean; dependencies?: Record<string, string> };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies?.eve).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);
  });

  // The seeded agent installs the SDK this platform release ships, not a
  // stale line a loose range could keep new instances on. release-please rewrites
  // the pin in the same release PR that bumps the SDK (extra-files).
  test("pins the eveland SDK at the version this tree ships", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(defaultTemplateDir(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const sdk = JSON.parse(
      await readFile(path.join(repoRoot, "packages/eveland/package.json"), "utf8"),
    ) as { version: string };
    expect(manifest.dependencies?.eveland).toBe(sdk.version);
  });

  test("the persona lives on the first line of instructions.md", async () => {
    const instructions = await readFile(
      path.join(defaultTemplateDir(), "agent", "instructions.md"),
      "utf8",
    );
    const firstLine = instructions.split("\n")[0]!;
    expect(firstLine).toContain("Stella");
    expect(firstLine).toContain("first line");
  });
});
