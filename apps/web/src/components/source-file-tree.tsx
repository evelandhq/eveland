"use client";

import { FileTree, useFileTree } from "@pierre/trees/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type CSSProperties } from "react";
import { getNextSourcePath } from "@/lib/source-tree";

const treeStyles = {
  height: "100%",
  minHeight: 0,
  "--trees-accent-override": "var(--foreground)",
  "--trees-bg-muted-override": "var(--muted)",
  "--trees-bg-override": "transparent",
  "--trees-border-color-override": "var(--border)",
  // Rows are rounded-md pills; the active row is a one-step fill, not accent.
  "--trees-border-radius-override": "var(--radius-md)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-mono)",
  "--trees-font-size-override": "12px",
  "--trees-selected-bg-override": "var(--secondary)",
  "--trees-selected-fg-override": "var(--secondary-foreground)",
} as CSSProperties;

const sourceFileTreeCss = `
  [data-file-tree-search-container] {
    box-sizing: border-box;
    height: 32px;
    margin: 0;
    padding: 0 12px;
    border-bottom: 1px solid var(--trees-border-color);
    align-items: center;
    flex: none;
  }

  [data-file-tree-search-input] {
    box-sizing: border-box;
    height: 31px;
    margin: 0;
    padding: 0;
    line-height: 31px;
    background: transparent;
    border: 0;
    border-radius: 0;
  }
`;

export function SourceFileTree({
  paths,
  projectId,
  selectedPath,
}: {
  paths: readonly string[];
  projectId: string;
  selectedPath: string | null;
}) {
  const router = useRouter();
  const isSynchronizingRef = useRef(false);
  const selectedPathRef = useRef(selectedPath);
  const pathSetRef = useRef(new Set(paths));
  const pathsKey = paths.join("\n");
  const pathsKeyRef = useRef(pathsKey);

  pathSetRef.current = new Set(paths);

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    icons: "complete",
    initialExpansion: 1,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    onSelectionChange(selectedPaths) {
      if (isSynchronizingRef.current) return;
      const nextPath = getNextSourcePath(
        selectedPaths,
        selectedPathRef.current,
        pathSetRef.current,
      );
      if (!nextPath || nextPath === selectedPathRef.current) return;

      selectedPathRef.current = nextPath;
      router.replace(`/projects/${projectId}/source?path=${encodeURIComponent(nextPath)}`, {
        scroll: false,
      });
    },
    paths,
    search: true,
    unsafeCSS: sourceFileTreeCss,
  });

  useEffect(() => {
    if (pathsKeyRef.current === pathsKey) return;
    pathsKeyRef.current = pathsKey;
    model.resetPaths(paths);
  }, [model, paths, pathsKey]);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
    if (!selectedPath) return;

    const selectedItem = model.getItem(selectedPath);
    if (!selectedItem) return;
    const selectedPaths = model.getSelectedPaths();
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) return;

    isSynchronizingRef.current = true;
    for (const path of selectedPaths) {
      if (path !== selectedPath) model.getItem(path)?.deselect();
    }
    if (!selectedItem.isSelected()) selectedItem.select();
    model.scrollToPath(selectedPath, { focus: false, offset: "nearest" });
    isSynchronizingRef.current = false;
  }, [model, selectedPath]);

  return <FileTree aria-label="Source files" model={model} style={treeStyles} />;
}
