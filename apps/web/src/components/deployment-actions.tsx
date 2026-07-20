"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCwIcon, RocketIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { enqueueBuildDeploy, syncSource } from "@/lib/client-api";
import { getProjectImportNotice, type Job } from "@/lib/api";

type PendingAction = "sync-promote" | "sync-preview" | "deploy";

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
      if (action === "deploy") {
        await enqueueBuildDeploy(projectId);
      } else {
        const deploy = importNotice?.active === false ? canDeploy : true;
        await syncSource(projectId, {
          deploy,
          promote: deploy && action === "sync-promote",
        });
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null || importNotice?.active === true;
  const retryingImport = importNotice?.active === false;
  const importActive = importNotice?.active === true;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {importKind === "git" ? (
          <>
            {!retryingImport || canDeploy ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => run("sync-preview")}
                disabled={!canSync || busy}
                title="Pull the latest commit and create a preview without changing production"
              >
                {pending === "sync-preview" ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
                {retryingImport ? "Retry sync & create preview" : "Sync & create preview"}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => run("sync-promote")}
              disabled={!canSync || busy}
              title="Pull the latest commit, deploy it, and promote it to production"
            >
              {pending === "sync-promote" || importActive ? <Spinner data-icon="inline-start" /> : <RocketIcon data-icon="inline-start" />}
              {retryingImport
                ? canDeploy
                  ? "Retry sync, deploy & promote"
                  : "Retry import"
                : importActive
                  ? "Fetching…"
                  : "Sync, deploy & promote"}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            onClick={() => run("deploy")}
            disabled={!canDeploy || busy}
            title="Rebuild and deploy the latest source revision"
          >
            {pending === "deploy" ? <Spinner data-icon="inline-start" /> : <RocketIcon data-icon="inline-start" />}
            Deploy latest
          </Button>
        )}
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
