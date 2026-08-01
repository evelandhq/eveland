import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { scanEveSource } from "./scan.js";

describe("scanEveSource", () => {
  test.each([
    [
      "pnpm-lock.yaml",
      { packageManager: "pnpm", hasLockfile: true },
    ],
    [
      "package-lock.json",
      { packageManager: "npm", hasLockfile: true },
    ],
  ] as const)(
    "retains oversized %s as SourceRevision runtime metadata without exposing empty content",
    async (lockfile, commandContext) => {
      const sourcePath = await mkdtemp(
        path.join(os.tmpdir(), "eveland-source-scan-"),
      );
      try {
        await mkdir(path.join(sourcePath, "agent"), { recursive: true });
        await writeFile(
          path.join(sourcePath, "package.json"),
          JSON.stringify({ dependencies: { eve: "^0.29.0" } }),
        );
        await writeFile(
          path.join(sourcePath, "agent", "instructions.md"),
          "You are concise.",
        );
        await writeFile(
          path.join(sourcePath, lockfile),
          "x".repeat(256 * 1024 + 1),
        );

        const scan = await scanEveSource({ kind: "zip", sourcePath });

        expect(scan.files).not.toContainEqual(
          expect.objectContaining({ path: lockfile }),
        );
        expect(scan.summary).toMatchObject({
          runtimeCommandContext: commandContext,
        });
      } finally {
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
  );
});
