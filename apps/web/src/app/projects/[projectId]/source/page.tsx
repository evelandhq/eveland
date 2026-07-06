import Link from "next/link";
import { getSourceFile, getSourceFiles, getSourceRevision } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ path?: string }>;
}) {
  const { projectId } = await params;
  const { path } = await searchParams;
  const [revision, files] = await Promise.all([getSourceRevision(projectId), getSourceFiles(projectId)]);
  const selectedPath = path ?? files[0]?.path ?? null;
  const selectedFile = selectedPath ? await getSourceFile(projectId, selectedPath) : null;
  const summaryEntries = revision ? Object.entries(revision.summary) : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <aside className="rounded-md border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Source tree</h2>
        <p className="mt-2 text-xs text-muted-foreground">{revision ? `${files.length} indexed files` : "No source revision yet."}</p>
        <div className="mt-4 flex max-h-[28rem] flex-col gap-1 overflow-auto text-xs">
          {files.map((file) => (
            <Link
              key={file.path}
              href={`/projects/${projectId}/source?path=${encodeURIComponent(file.path)}`}
              className="truncate rounded-sm px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {file.path}
            </Link>
          ))}
        </div>
      </aside>
      <section className="flex flex-col gap-4">
        <div className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">eve project summary</h2>
            <p className="mt-1 text-xs text-muted-foreground">{revision?.commitSha ?? revision?.sourcePath ?? "Import a source revision to populate this view."}</p>
          </div>
          <div className="grid gap-px bg-border md:grid-cols-2">
            {summaryEntries.length === 0 ? (
              <div className="bg-card p-4 text-sm text-muted-foreground">No summary available.</div>
            ) : (
              summaryEntries.map(([key, value]) => (
                <div key={key} className="bg-card p-4">
                  <div className="text-xs uppercase text-muted-foreground">{key}</div>
                  <div className="mt-2 break-words text-sm">{Array.isArray(value) ? `${value.length} discovered` : String(value)}</div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{selectedFile?.path ?? "File content"}</h2>
          </div>
          <pre className="max-h-[36rem] overflow-auto p-4 text-xs leading-5">
            <code>{selectedFile?.content ?? "Select a file to inspect its content."}</code>
          </pre>
        </div>
      </section>
    </div>
  );
}
