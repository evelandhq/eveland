"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, RefreshCwIcon, RocketIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enqueueBuildDeploy, syncSource } from "@/lib/client-api";

type PendingAction = "sync" | "deploy";

export function DeploymentActions({
  projectId,
  importKind,
  canSync,
  canDeploy,
}: {
  projectId: string;
  importKind: "git" | "zip";
  canSync: boolean;
  canDeploy: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: PendingAction) {
    setPending(action);
    setError(null);

    try {
      await (action === "sync" ? syncSource(projectId, { deploy: true }) : enqueueBuildDeploy(projectId));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {importKind === "git" ? (
          <Button type="button" onClick={() => run("sync")} disabled={!canSync || busy} title="Pull the latest commit from GitHub, then deploy it">
            <RefreshCwIcon data-icon="inline-start" className={pending === "sync" ? "animate-spin" : undefined} />
            Sync &amp; deploy
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
      {error ? <p className="max-w-72 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
