import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodeIcon } from "lucide-react";
import { describe, expect, test } from "vitest";
import { getProjectNavigationItems } from "@/lib/navigation";

function source(relativePath: string): string {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  expect(existsSync(path), relativePath).toBe(true);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("project Source workspace", () => {
  test("uses the Lucide code icon in project navigation", () => {
    const sourceItem = getProjectNavigationItems("project-123").find(
      (item) => item.href === "/projects/project-123/source",
    );

    expect(sourceItem?.icon).toBe(CodeIcon);
  });

  test("opts Source out of the padded project page container", () => {
    const projectLayout = source("./projects/[projectId]/layout.tsx");
    const projectContent = source("../components/project-content.tsx");

    expect(projectLayout).toContain("<ProjectContent");
    expect(projectContent).toContain('pathname.endsWith("/source")');
    expect(projectContent).toContain('className="flex h-[calc(100svh-3rem-1px)]');
    expect(projectContent).toContain("<PageContainer");
    expect(projectContent).toContain('className="contents"');
  });

  test("keeps the Source workspace fixed while the code pane scrolls independently", () => {
    const projectContent = source("../components/project-content.tsx");
    const page = source("./projects/[projectId]/source/page.tsx");
    const codeView = source("../components/source-code-view.tsx");

    expect(projectContent).toContain("h-[calc(100svh-3rem-1px)]");
    expect(projectContent).toContain("overflow-hidden");
    expect(projectContent).toContain("md:h-svh");
    expect(page).toContain('className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card"');
    expect(codeView).toContain('className="h-full min-w-0 w-full overflow-hidden bg-background"');
  });

  test("fills the Source canvas with a compact searchable file browser", () => {
    const page = source("./projects/[projectId]/source/page.tsx");
    const tree = source("../components/source-file-tree.tsx");

    expect(page).toContain(
      'className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(12rem,35%)_minmax(0,1fr)] overflow-hidden',
    );
    expect(page).toContain('className="flex h-8 shrink-0 min-w-0 items-center border-b px-3"');
    expect(tree).toContain("search: true");
    expect(page).not.toContain("Source files");
    expect(page).not.toContain("files.length");
    expect(page).not.toContain("EveVersionStatus");
    expect(page).not.toContain("selectedFile.size");
    expect(page).not.toContain("selectedLanguage");
    expect(page).not.toContain("rounded-xl border");
  });

  test("lets source code use the complete preview pane", () => {
    const projectContent = source("../components/project-content.tsx");
    const codeView = source("../components/source-code-view.tsx");

    expect(projectContent).toContain('className="m-0 flex min-h-0 min-w-0 flex-1 border-0 p-0"');
    expect(codeView).toContain("unsafeCSS: sourceCodeCss");
    expect(codeView).toContain("pre[data-file]");
    expect(codeView).toContain("[data-code]");
    expect(codeView).toContain("height: 100%;");
    expect(codeView).toContain("width: 100%;");
    expect(codeView).toContain("overflow: auto;");
    expect(codeView).toContain("[data-code]::-webkit-scrollbar-thumb");
    expect(codeView).toContain("background-color: color-mix(");
    expect(codeView).toContain("[--diffs-gap-block:0]");
    expect(codeView).toContain("[--diffs-gap-inline:0]");
  });

  test("uses compact code typography and a semantic muted line number color", () => {
    const codeView = source("../components/source-code-view.tsx");

    expect(codeView).toContain("[--diffs-font-size:12px]");
    expect(codeView).toContain("[--diffs-line-height:18px]");
    expect(codeView).toContain("[--diffs-fg-number-override:var(--muted-foreground)]");
    expect(codeView).not.toContain("[--diffs-line-height:1.5rem]");
  });

  test("keeps short files packed at the top instead of stretching grid rows", () => {
    const codeView = source("../components/source-code-view.tsx");

    expect(codeView).toContain("align-content: start;");
  });

  test("aligns a borderless file search with the file header", () => {
    const tree = source("../components/source-file-tree.tsx");

    expect(tree).toContain("height: 32px;");
    expect(tree).toContain("border-bottom: 1px solid var(--trees-border-color);");
    expect(tree).toContain("[data-file-tree-search-input]");
    expect(tree).toContain("border: 0;");
    expect(tree).toContain("background: transparent;");
    expect(tree).toContain("unsafeCSS: sourceFileTreeCss");
  });
});
