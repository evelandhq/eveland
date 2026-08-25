"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  archiveDeployment,
  drainDeployment,
  promoteDeployment,
  updateRouteTargets,
} from "@/lib/client-api";

export function DeploymentTrafficActions({
  projectId,
  deploymentId,
  productionDeploymentId,
  stableRouteId,
  status,
  retentionProtected,
}: {
  projectId: string;
  deploymentId: string;
  productionDeploymentId: string | null;
  stableRouteId: string | null;
  status: string;
  retentionProtected: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Slow requests used to leave the whole row looking inert (buttons only go
  // `disabled`), and the actioned button re-enabled before the refresh made
  // the effect visible (#142). The clicked button now spins through both
  // phases — the request (`pending`) and the refresh that makes the change
  // visible (`settling`, cleared when the transition ends).
  const [settling, setSettling] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  useEffect(() => {
    if (!refreshing) setSettling(null);
  }, [refreshing]);
  const active = pending ?? settling;
  const busy = active !== null || refreshing;
  // Synchronous re-entry guard: `disabled` only takes effect once the pending
  // state commits, and a double click can land in that gap.
  const inFlight = useRef(false);

  async function run(name: string, action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(name);
    setError(null);
    try {
      await action();
      setSettling(name);
      startRefresh(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function actionIcon(name: string) {
    return active === name ? <Spinner data-icon="inline-start" /> : null;
  }

  const canSplit =
    stableRouteId &&
    productionDeploymentId &&
    productionDeploymentId !== deploymentId &&
    status === "running";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || status !== "running"}
        onClick={() => run("promote", () => promoteDeployment(projectId, deploymentId))}
      >
        {actionIcon("promote")}
        Promote / rollback
      </Button>
      {canSplit ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run("90/10", () =>
                updateRouteTargets(projectId, stableRouteId, [
                  { deploymentId: productionDeploymentId, weight: 9000, variantName: "control" },
                  { deploymentId, weight: 1000, variantName: "candidate" },
                ]),
              )
            }
          >
            {actionIcon("90/10")}
            90/10
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run("50/50", () =>
                updateRouteTargets(projectId, stableRouteId, [
                  { deploymentId: productionDeploymentId, weight: 5000, variantName: "control" },
                  { deploymentId, weight: 5000, variantName: "candidate" },
                ]),
              )
            }
          >
            {actionIcon("50/50")}
            50/50
          </Button>
        </>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || status !== "running"}
        onClick={() => run("drain", () => drainDeployment(projectId, deploymentId))}
      >
        {actionIcon("drain")}
        Drain
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || retentionProtected || status === "archived" || status === "archiving"}
        onClick={() => run("archive", () => archiveDeployment(projectId, deploymentId))}
      >
        {actionIcon("archive")}
        Archive
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
