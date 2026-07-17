import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { importGitSource } from "./importer.js";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("git source importer", () => {
  test("fails with an actionable error when git clone exceeds its timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-git-timeout-"));
    temporaryDirectories.push(root);
    await useFakeGit(root, "mkdir -p \"$5\"\nsleep 0.25");

    await expect(
      importGitSource({
        gitUrl: "https://example.com/agent.git",
        targetDir: path.join(root, "source"),
        timeoutMs: 50,
        maxAttempts: 1,
      }),
    ).rejects.toThrow("Repository fetch timed out after 50ms. Check the worker network, proxy, DNS, or repository availability, then retry.");
  });

  test("removes a partial source directory when git clone fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-git-failure-"));
    temporaryDirectories.push(root);
    await useFakeGit(root, "mkdir -p \"$5\"\nexit 1");
    const targetDir = path.join(root, "source");

    await expect(importGitSource({ gitUrl: "https://example.com/agent.git", targetDir, maxAttempts: 1 })).rejects.toThrow();

    await expect(access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("disables interactive git credential prompts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-git-noninteractive-"));
    temporaryDirectories.push(root);
    await useFakeGit(root, "[ \"$GIT_TERMINAL_PROMPT\" = \"0\" ] || exit 42\nmkdir -p \"$5\"");

    await expect(
      importGitSource({ gitUrl: "https://example.com/agent.git", targetDir: path.join(root, "source") }),
    ).resolves.toBeUndefined();
  });

  test("supplies a GitLab PAT through host-scoped Git configuration without putting it in the clone URL", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-git-pat-"));
    temporaryDirectories.push(root);
    await useFakeGit(root, `
[ "$GIT_CONFIG_COUNT" = "1" ] || exit 40
[ "$GIT_CONFIG_KEY_0" = "http.https://gitlab.example.com:8443/.extraHeader" ] || exit 41
[ "$GIT_CONFIG_VALUE_0" = "Authorization: Basic b2F1dGgyOmdscGF0LXNlY3JldA==" ] || exit 42
[ "$4" = "https://gitlab.example.com:8443/group/agent.git" ] || exit 43
mkdir -p "$5"`);

    await expect(importGitSource({
      gitUrl: "https://gitlab.example.com:8443/group/agent.git",
      targetDir: path.join(root, "source"),
      credential: { host: "gitlab.example.com:8443", token: "glpat-secret" },
    })).resolves.toBeUndefined();
  });

  test("redacts a PAT and its Basic authorization value from Git errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-git-pat-redaction-"));
    temporaryDirectories.push(root);
    await useFakeGit(root, "echo \"fatal: $GIT_CONFIG_VALUE_0 glpat-secret\" >&2\nexit 1");

    const failure = await importGitSource({
      gitUrl: "https://gitlab.example.com/group/agent.git",
      targetDir: path.join(root, "source"),
      credential: { host: "gitlab.example.com", token: "glpat-secret" },
      maxAttempts: 1,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("glpat-secret");
    expect((failure as Error).message).not.toContain("b2F1dGgyOmdscGF0LXNlY3JldA==");
    expect((failure as Error).message).toContain("***");
  });

  test("reports git stderr without exposing URL credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-git-redaction-"));
    temporaryDirectories.push(root);
    await useFakeGit(root, "echo 'fatal: unable to access https://secret-token@example.com/agent.git' >&2\nexit 1");

    const failure = await importGitSource({
      gitUrl: "https://secret-token@example.com/agent.git",
      targetDir: path.join(root, "source"),
      maxAttempts: 1,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("fatal: unable to access https://***@example.com/agent.git");
    expect((failure as Error).message).not.toContain("secret-token");
  });

  test("retries a transient network failure and succeeds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-git-retry-"));
    temporaryDirectories.push(root);
    const attemptsPath = path.join(root, "attempts");
    await useFakeGit(root, `[ -f "${attemptsPath}" ] && count=$(cat "${attemptsPath}") || count=0
count=$((count + 1))
echo "$count" > "${attemptsPath}"
if [ "$count" -eq 1 ]; then echo 'fatal: Could not resolve host: example.com' >&2; exit 1; fi
mkdir -p "$5"`);
    const retries: number[] = [];

    await expect(importGitSource({
      gitUrl: "https://example.com/agent.git",
      targetDir: path.join(root, "source"),
      maxAttempts: 2,
      retryDelayMs: 0,
      onRetry: (attempt) => { retries.push(attempt); },
    })).resolves.toBeUndefined();

    expect(retries).toEqual([2]);
  });

  test("does not treat an invalid attempt count as a successful import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-git-invalid-attempts-"));
    temporaryDirectories.push(root);
    await useFakeGit(root, "echo 'fatal: repository not found' >&2\nexit 1");

    await expect(importGitSource({
      gitUrl: "https://example.com/agent.git",
      targetDir: path.join(root, "source"),
      maxAttempts: Number.NaN,
    })).rejects.toThrow("Repository fetch failed");
  });
});

async function useFakeGit(root: string, body: string): Promise<void> {
  const binDir = path.join(root, "bin");
  const gitPath = path.join(binDir, "git");
  await mkdir(binDir, { recursive: true });
  await writeFile(gitPath, `#!/bin/sh\n${body}\n`, { flag: "wx" });
  await chmod(gitPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}
