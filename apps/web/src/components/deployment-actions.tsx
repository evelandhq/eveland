"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, RefreshCwIcon, RocketIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enqueueBuildDeploy, syncSource } from "@/lib/api";

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
  const actionLock = useRef(false);
  const actionVersion = useRef(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    actionVersion.current += 1;
    actionLock.current = false;
    setPending(null);
    setQueued(false);
    setError(null);
  }, [projectId]);

  async function run(action: PendingAction) {
    if (actionLock.current) {
      return;
    }
    actionLock.current = true;
    const requestVersion = actionVersion.current;
    setPending(action);
    setQueued(false);
    setError(null);

    try {
      await (action === "sync" ? syncSource(projectId, { deploy: true }) : enqueueBuildDeploy(projectId));
      if (actionVersion.current !== requestVersion) {
        return;
      }
      setQueued(true);
      router.refresh();
    } catch (caught) {
      if (actionVersion.current !== requestVersion) {
        return;
      }
      actionLock.current = false;
      setPending(null);
      setError(caught instanceof Error ? caught.message : "Request failed");
    }
  }

  const busy = pending !== null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {importKind === "git" ? (
          <Button type="button" onClick={() => run("sync")} disabled={!canSync || busy} title="Pull the latest commit from GitHub, then deploy it">
            <RefreshCwIcon data-icon="inline-start" className={pending === "sync" && !queued ? "animate-spin" : undefined} />
            {pending === "sync" ? (queued ? "Sync queued" : "Syncing...") : "Sync & deploy"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant={importKind === "git" ? "outline" : "default"}
          onClick={() => run("deploy")}
          disabled={!canDeploy || busy}
          title="Rebuild and deploy the current source revision"
        >
          {pending === "deploy" && !queued ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <RocketIcon data-icon="inline-start" />}
          {pending === "deploy" ? (queued ? "Deploy queued" : "Deploying...") : importKind === "git" ? "Deploy current" : "Deploy latest"}
        </Button>
      </div>
      {error ? <p className="max-w-72 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
