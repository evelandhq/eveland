"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, RefreshCwIcon, RocketIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enqueueBuildDeploy, syncSource } from "@/lib/client-api";
import { getProjectImportNotice, type Job } from "@/lib/api";

type PendingAction = "sync" | "deploy";

export function DeploymentActions({
  projectId,
  importKind,
  canSync,
  canDeploy,
  importJob,
}: {
  projectId: string;
  importKind: "git" | "zip";
  canSync: boolean;
  canDeploy: boolean;
  importJob: Job | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importNotice = getProjectImportNotice(importJob);

  useEffect(() => {
    if (!importNotice?.active) return;
    const interval = window.setInterval(() => router.refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [importNotice?.active, router]);

  async function run(action: PendingAction) {
    setPending(action);
    setError(null);

    try {
      await (action === "sync"
        ? syncSource(projectId, { deploy: importNotice?.active === false ? canDeploy : true })
        : enqueueBuildDeploy(projectId));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null || importNotice?.active === true;
  const retryingImport = importNotice?.active === false;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {importKind === "git" ? (
          <Button type="button" onClick={() => run("sync")} disabled={!canSync || busy} title="Pull the latest commit from GitHub, then deploy it">
            <RefreshCwIcon data-icon="inline-start" className={pending === "sync" || importNotice?.active ? "animate-spin" : undefined} />
            {retryingImport ? (canDeploy ? "Retry sync & deploy" : "Retry import") : importNotice?.active ? "Fetching…" : "Sync & deploy"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant={importKind === "git" ? "outline" : "default"}
          onClick={() => run("deploy")}
          disabled={!canDeploy || busy}
          title="Rebuild and deploy the current source revision"
        >
          {pending === "deploy" ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <RocketIcon data-icon="inline-start" />}
          {importKind === "git" ? "Deploy current" : "Deploy latest"}
        </Button>
      </div>
      {importNotice ? (
        <div className={`max-w-80 text-right text-xs ${retryingImport ? "text-destructive" : "text-muted-foreground"}`}>
          <p className="font-medium">{importNotice.title}</p>
          <p className="mt-1 leading-5">{importNotice.detail}</p>
        </div>
      ) : null}
      {error ? <p className="max-w-80 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
