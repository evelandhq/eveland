import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");

  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("page-action Markdown assets", () => {
  test("generates clean localized Markdown and removes stale output", async () => {
    const generatorPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../scripts/generate-llm-pages.mjs",
    );
    expect(existsSync(generatorPath)).toBe(true);
    if (!existsSync(generatorPath)) return;

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "eveland-llm-pages-"));
    temporaryDirectories.push(temporaryDirectory);
    const docsDirectory = join(temporaryDirectory, "docs");
    const outputDirectory = join(temporaryDirectory, "public", "_llms");

    await mkdir(join(docsDirectory, "en", "guide"), { recursive: true });
    await mkdir(join(docsDirectory, "zh"), { recursive: true });
    await mkdir(join(outputDirectory, "en"), { recursive: true });
    await writeFile(join(outputDirectory, "en", "stale.md"), "stale");
    await writeFile(
      join(docsDirectory, "en", "guide", "index.md"),
      "---\ntitle: Build an Agent\ndescription: A guide.\n---\n\n## Start here\n\nDeploy it.\n",
    );
    await writeFile(
      join(docsDirectory, "zh", "index.md"),
      "---\ntitle: 概览\ndescription: 平台概览。\n---\n\n## 从这里开始\n",
    );

    const generator = await import(pathToFileURL(generatorPath).href);
    const result = await generator.generateLlmPages({ docsDirectory, outputDirectory });

    expect(result).toEqual({ pages: 2 });
    expect(await readFile(join(outputDirectory, "en", "guide.md"), "utf8")).toBe(
      "# Build an Agent (/docs/guide)\n\n## Start here\n\nDeploy it.\n",
    );
    expect(await readFile(join(outputDirectory, "zh", "index.md"), "utf8")).toBe(
      "# 概览 (/zh/docs)\n\n## 从这里开始\n",
    );
    expect(existsSync(join(outputDirectory, "en", "stale.md"))).toBe(false);
  });
});
