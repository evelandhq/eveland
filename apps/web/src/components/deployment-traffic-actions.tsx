"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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

  async function run(name: string, action: () => Promise<void>) {
    setPending(name);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setPending(null);
    }
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
        disabled={pending !== null || status !== "running"}
        onClick={() => run("promote", () => promoteDeployment(projectId, deploymentId))}
      >
        Promote / rollback
      </Button>
      {canSplit ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null}
            onClick={() =>
              run("90/10", () =>
                updateRouteTargets(projectId, stableRouteId, [
                  { deploymentId: productionDeploymentId, weight: 9000, variantName: "control" },
                  { deploymentId, weight: 1000, variantName: "candidate" },
                ]),
              )
            }
          >
            90/10
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null}
            onClick={() =>
              run("50/50", () =>
                updateRouteTargets(projectId, stableRouteId, [
                  { deploymentId: productionDeploymentId, weight: 5000, variantName: "control" },
                  { deploymentId, weight: 5000, variantName: "candidate" },
                ]),
              )
            }
          >
            50/50
          </Button>
        </>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={pending !== null || status !== "running"}
        onClick={() => run("drain", () => drainDeployment(projectId, deploymentId))}
      >
        Drain
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={
          pending !== null || retentionProtected || status === "archived" || status === "archiving"
        }
        onClick={() => run("archive", () => archiveDeployment(projectId, deploymentId))}
      >
        Archive
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
