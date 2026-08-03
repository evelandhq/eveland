import { describe, expect, test } from "vitest";

type SourceLanguageModule = {
  getSourceLanguage(filePath: string): string;
};

async function loadSourceLanguageModule(): Promise<SourceLanguageModule | null> {
  const modulePath = "./source-language";
  return import(modulePath).catch(() => null) as Promise<SourceLanguageModule | null>;
}

describe("source language labels", () => {
  test("selects a grammar from common project filenames", async () => {
    const sourceLanguage = await loadSourceLanguageModule();

    expect(sourceLanguage).not.toBeNull();
    expect(sourceLanguage?.getSourceLanguage("src/agent.ts")).toBe("typescript");
    expect(sourceLanguage?.getSourceLanguage("src/panel.tsx")).toBe("tsx");
    expect(sourceLanguage?.getSourceLanguage("README.md")).toBe("markdown");
    expect(sourceLanguage?.getSourceLanguage("Dockerfile")).toBe("dockerfile");
    expect(sourceLanguage?.getSourceLanguage("data.unknown")).toBe("text");
  });
});
