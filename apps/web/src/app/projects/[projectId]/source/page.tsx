import { FileCodeIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { SourceCodeView } from '@/components/source-code-view';
import { SourceFileTree } from '@/components/source-file-tree';
import { getEveVersion, getSourceFiles } from '@/lib/server-api';
import { getSourceLanguage } from '@/lib/source-language';
import { EveVersionStatus } from '@/components/eve-version-status';

export const dynamic = 'force-dynamic';
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
  const [files, eveVersion] = await Promise.all([getSourceFiles(projectId), getEveVersion(projectId)]);
  const selectedPath = files.some((file) => file.path === path) ? path ?? null : files[0]?.path ?? null;
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;
  const selectedLanguage = selectedFile ? getSourceLanguage(selectedFile.path) : null;

  return (
    <div className="grid -m-5 min-h-[calc(100svh-6.5625rem)] min-w-0 overflow-hidden bg-background md:min-h-[calc(100svh-3.5rem)] lg:h-[calc(100svh-3.5rem)] lg:min-h-0 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="flex min-h-80 min-w-0 flex-col border-b lg:h-full lg:min-h-0 lg:border-r lg:border-b-0">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
          <h2 className="text-sm font-medium">Source files</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
        </header>
        <div className="min-h-0 flex-1 p-1.5">
          <SourceFileTree
            paths={files.map((file) => file.path)}
            projectId={projectId}
            selectedPath={selectedPath}
          />
        </div>
        <footer className="border-t px-4 py-2.5">
          <EveVersionStatus className="items-start" eveVersion={eveVersion} showMessage={false} />
        </footer>
      </aside>

      <section className="flex min-h-[30rem] min-w-0 flex-col lg:min-h-0">
        <header className="flex h-12 shrink-0 min-w-0 items-center justify-between gap-4 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <FileCodeIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate font-mono text-sm font-medium">
              {selectedFile?.path ?? 'File content'}
            </h1>
          </div>
          {selectedFile ? (
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="secondary">{selectedLanguage}</Badge>
              <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
                {selectedFile.size.toLocaleString()} bytes
              </span>
            </div>
          ) : null}
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
