import { FileCodeIcon } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SourceCodeView } from "@/components/source-code-view";
import { SourceFileTree } from "@/components/source-file-tree";
import { getSourceFiles } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Source",
};

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ path?: string }>;
}) {
  const { projectId } = await params;
  const { path } = await searchParams;
  const files = await getSourceFiles(projectId);
  const selectedPath = files.some((file) => file.path === path)
    ? (path ?? null)
    : (files[0]?.path ?? null);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(12rem,35%)_minmax(0,1fr)] overflow-hidden lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-none">
      <aside className="flex min-h-0 min-w-0 flex-col border-b bg-muted/30 lg:border-r lg:border-b-0">
        <div className="min-h-0 flex-1">
          <SourceFileTree
            paths={files.map((file) => file.path)}
            projectId={projectId}
            selectedPath={selectedPath}
          />
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card">
        <header className="flex h-8 shrink-0 min-w-0 items-center border-b px-3">
          <FileCodeIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="ml-2 truncate font-mono text-xs font-medium">
            {selectedFile?.path ?? "File content"}
          </h1>
        </header>
        <div className="min-h-0 flex-1">
          {selectedFile ? (
            <SourceCodeView
              cacheKey={selectedFile.id}
              content={selectedFile.content}
              path={selectedFile.path}
            />
          ) : (
            <Empty className="h-full min-h-80">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileCodeIcon />
                </EmptyMedia>
                <EmptyTitle>No source selected</EmptyTitle>
                <EmptyDescription>Choose an indexed file from the source list.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </section>
    </div>
  );
}
