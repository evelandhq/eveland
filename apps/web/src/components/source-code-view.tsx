"use client";

import { File, type FileOptions } from "@pierre/diffs/react";
import { useMemo } from "react";

const sourceCodeCss = `
  :host {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  pre[data-file] {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  [data-code] {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    align-content: start;
    align-self: stretch;
  }

  [data-code]::-webkit-scrollbar {
    width: var(--diffs-scrollbar-gutter);
    height: var(--diffs-scrollbar-gutter);
  }

  [data-code]::-webkit-scrollbar-thumb {
    background-color: color-mix(in lab, var(--diffs-fg) 25%, transparent);
  }
`;

const fileOptions = {
  disableFileHeader: true,
  overflow: "scroll",
  unsafeCSS: sourceCodeCss,
} satisfies FileOptions<undefined>;

export function SourceCodeView({
  cacheKey,
  content,
  path,
}: {
  cacheKey: string;
  content: string;
  path: string;
}) {
  const file = useMemo(
    () => ({
      cacheKey,
      contents: content,
      name: path,
    }),
    [cacheKey, content, path],
  );

  return (
    <div className="h-full min-w-0 w-full overflow-hidden bg-background">
      <File
        className="h-full min-h-0 min-w-0 w-full [--diffs-fg-number-override:var(--muted-foreground)] [--diffs-font-size:12px] [--diffs-gap-block:0] [--diffs-gap-inline:0] [--diffs-line-height:18px]"
        file={file}
        options={fileOptions}
      />
    </div>
  );
}
