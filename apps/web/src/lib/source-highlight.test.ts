import { describe, expect, test } from "vitest"

type SourceHighlightModule = {
  getSourceLanguage(filePath: string): string
  highlightSourceCode(source: string, filePath: string): Promise<string>
}

async function loadSourceHighlightModule(): Promise<SourceHighlightModule | null> {
  const modulePath = "./source-highlight"
  return import(modulePath).catch(() => null) as Promise<SourceHighlightModule | null>
}

describe("source code highlighting", () => {
  test("selects a grammar from common project filenames", async () => {
    const sourceHighlight = await loadSourceHighlightModule()

    expect(sourceHighlight).not.toBeNull()
    expect(sourceHighlight?.getSourceLanguage("src/agent.ts")).toBe("typescript")
    expect(sourceHighlight?.getSourceLanguage("src/panel.tsx")).toBe("tsx")
    expect(sourceHighlight?.getSourceLanguage("README.md")).toBe("markdown")
    expect(sourceHighlight?.getSourceLanguage("Dockerfile")).toBe("dockerfile")
    expect(sourceHighlight?.getSourceLanguage("data.unknown")).toBe("text")
  })

  test("returns tokenized HTML for source code", async () => {
    const sourceHighlight = await loadSourceHighlightModule()

    expect(sourceHighlight).not.toBeNull()
    const html = await sourceHighlight?.highlightSourceCode("const answer: number = 42", "answer.ts")
    expect(html).toContain('class="shiki')
    expect(html).toContain("<span")
    expect(html).toContain("const")
  })
})
