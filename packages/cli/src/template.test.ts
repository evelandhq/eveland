import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { defaultTemplateDir } from "./init.ts";

/**
 * Invariants of the starter template that once broke real imports or would
 * silently degrade a scaffolded project. The eve version window pin lives in
 * architecture-tests (it needs the platform policy); everything here is
 * self-contained.
 */

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

  test("the eve channel keeps its capability-detectable literal shape", async () => {
    const channel = await readFile(
      path.join(defaultTemplateDir(), "agent", "channels", "eve.ts"),
      "utf8",
    );
    // Source import detects the chat capability with these literal patterns.
    expect(channel).toMatch(/from "eve\/channels\/eve"/);
    expect(channel).toMatch(/export default eveChannel\(/);
    expect(channel).toContain("evelandIdentity()");
  });

  test("package.json pins the model-facing dependencies the platform expects", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(defaultTemplateDir(), "package.json"), "utf8"),
    ) as { private?: boolean; dependencies?: Record<string, string> };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies?.eve).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.dependencies?.eveland).toMatch(/^\^\d+\.\d+\.\d+$/);
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
