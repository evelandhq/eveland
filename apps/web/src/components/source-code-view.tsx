"use client"

import { File, type FileOptions } from "@pierre/diffs/react"
import { useMemo } from "react"

const fileOptions = {
  disableFileHeader: true,
  overflow: "scroll",
} satisfies FileOptions<undefined>

export function SourceCodeView({
  cacheKey,
  content,
  path,
}: {
  cacheKey: string
  content: string
  path: string
}) {
  const file = useMemo(
    () => ({
      cacheKey,
      contents: content,
      name: path,
    }),
    [cacheKey, content, path],
  )

  return (
    <div className="h-full overflow-auto bg-background">
      <File
        className="min-h-full [--diffs-gap-block:1rem] [--diffs-gap-inline:1rem] [--diffs-line-height:1.5rem]"
        file={file}
        options={fileOptions}
      />
    </div>
  )
}
