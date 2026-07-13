import Link from "next/link"
import { FileCodeIcon } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { getSourceFile, getSourceFiles } from "@/lib/api"
import { cn } from "@/lib/utils"
import { getSourceLanguage, highlightSourceCode } from "@/lib/source-highlight"

export const dynamic = "force-dynamic"

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ path?: string }>
}) {
  const { projectId } = await params
  const { path } = await searchParams
  const files = await getSourceFiles(projectId)
  const selectedPath = path ?? files[0]?.path ?? null
  const selectedFile = selectedPath ? await getSourceFile(projectId, selectedPath) : null
  const highlightedSource = selectedFile
    ? await highlightSourceCode(selectedFile.content, selectedFile.path)
    : null
  const selectedLanguage = selectedFile ? getSourceLanguage(selectedFile.path) : null

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <Card size="sm" className="h-fit lg:sticky lg:top-16">
        <CardHeader>
          <CardTitle>Source files</CardTitle>
          <CardDescription>Browse the indexed project revision.</CardDescription>
        </CardHeader>
        <CardContent>
          <nav className="flex max-h-[calc(100svh-16rem)] flex-col gap-px overflow-auto text-xs">
            {files.map((file) => (
              <Link
                key={file.path}
                href={`/projects/${projectId}/source?path=${encodeURIComponent(file.path)}`}
                className={cn(
                  "truncate rounded-sm px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground",
                  file.path === selectedPath && "bg-muted font-medium text-foreground",
                )}
              >
                {file.path}
              </Link>
            ))}
          </nav>
        </CardContent>
        <CardFooter className="border-t text-xs text-muted-foreground">
          {files.length} indexed {files.length === 1 ? "file" : "files"}
        </CardFooter>
      </Card>

      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="truncate">{selectedFile?.path ?? "File content"}</CardTitle>
          <CardDescription>
            {selectedFile ? `${selectedLanguage} · ${selectedFile.size.toLocaleString()} bytes` : "Select a source file to inspect it."}
          </CardDescription>
        </CardHeader>
        <CardContent className="-mx-(--card-spacing)">
          {highlightedSource ? (
            <div
              className="max-h-[calc(100svh-14rem)] overflow-auto border-y [&_.shiki]:min-h-full [&_.shiki]:min-w-max [&_.shiki]:bg-transparent! [&_.shiki]:p-4 [&_.shiki]:font-mono [&_.shiki]:text-xs [&_.shiki]:leading-6"
              dangerouslySetInnerHTML={{ __html: highlightedSource }}
            />
          ) : (
            <Empty className="min-h-80">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileCodeIcon />
                </EmptyMedia>
                <EmptyTitle>No source selected</EmptyTitle>
                <EmptyDescription>Choose an indexed file from the source list.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
        <CardFooter className="justify-between text-xs text-muted-foreground">
          <span>{selectedLanguage ?? "text"}</span>
          <span>{selectedFile?.path.split("/").at(-1) ?? "No file"}</span>
        </CardFooter>
      </Card>
    </div>
  )
}
