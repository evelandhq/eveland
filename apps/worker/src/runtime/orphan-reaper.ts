import type { RuntimeKind } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";
import { createRuntimeAdapterForKind } from "./select.js";
import type { ProcessDirectoryCapability, RuntimeAdapter } from "./types.js";
import {
  listOrphanAgentTelemetryNetworks,
  removeOrphanAgentTelemetryNetwork,
  type ManagedAgentTelemetryNetwork,
} from "./docker/agent-network.js";

export const DEPLOYMENT_PROCESS_PREFIX = "eveland-";

// Deployment processes are always named `eveland-<project>-<deployment>` where
// the final segment is a processSafeName'd `dep_...` id. The production Compose
// topology names the platform's own containers with the same prefix
// (`eveland-postgres-1`, `eveland-api-1`, ...), so a prefix match alone must
// never feed a stop decision; the sweep only ever considers names matching the
// full deployment shape.
const deploymentProcessNamePattern = /^eveland-.+-dep_[a-z0-9]+$/;

export type OrphanProcessReaperOptions = {
  /**
   * How long a process may stay out-of-model before it is stopped. Covers the
   * legitimate window where build_deploy starts a process before its
   * Deployment row exists.
   */
  graceMs?: number;
  kinds?: RuntimeKind[];
  runtimeForKind?: (kind: RuntimeKind) => RuntimeAdapter & ProcessDirectoryCapability;
  listOrphanDockerNetworks?: () => Promise<ManagedAgentTelemetryNetwork[]>;
  removeOrphanDockerNetwork?: (network: ManagedAgentTelemetryNetwork) => Promise<boolean>;
};

/**
 * Brings host reality in line with the control plane. Any running
 * `eveland-*-dep_*` process is either already managed (live RuntimeInstance or
 * active leases), adopted into a RuntimeInstance so the normal idle lifecycle
 * owns it from then on, or -- when no Deployment can legitimately own it
 * (row gone, archived, or recorded under another runtime kind) -- stopped
 * after the grace period. This is what retires pre-RuntimeInstance "zombie"
 * deployments that the idle reaper and reconciler cannot see. Managed Agent
 * telemetry networks with no remaining container follow the same grace period
 * and are removed only after a final container-existence check.
 */
export function createOrphanProcessReaper(store: Store, options: OrphanProcessReaperOptions = {}) {
  const graceMs = options.graceMs ?? 300_000;
  const kinds: RuntimeKind[] = options.kinds ?? ["systemd", "docker"];
  const runtimeForKind = options.runtimeForKind ?? createRuntimeAdapterForKind;
  const listOrphanDockerNetworks =
    options.listOrphanDockerNetworks ?? listOrphanAgentTelemetryNetworks;
  const removeOrphanDockerNetwork =
    options.removeOrphanDockerNetwork ?? removeOrphanAgentTelemetryNetwork;
  const firstSeenAt = new Map<string, number>();

  async function sweepProcess(
    adapter: RuntimeAdapter,
    kind: RuntimeKind,
    name: string,
    key: string,
    now: Date,
  ): Promise<number> {
    const deployment = await store.getDeploymentByContainerName(name);
    if (deployment && deployment.runtimeKind === kind) {
      if (await store.hasActiveActivationLeases(deployment.id, now)) {
        firstSeenAt.delete(key);
        return 0;
      }
      const instances = await store.listDeploymentRuntimeInstances(deployment.id);
      if (
        instances.some(
          (instance) =>
            instance.status === "starting" ||
            instance.status === "ready" ||
            instance.status === "draining",
        )
      ) {
        firstSeenAt.delete(key);
        return 0;
      }
      if (deployment.status === "running" || deployment.status === "draining") {
        // Running but unmanaged (deployed or restarted before RuntimeInstances
        // existed, or never activated since). Adoption -- not stopping -- is
        // the action here: the idle reaper then drains it with its own lease
        // re-checks, so an explicit user restart is never killed behind a
        // racing activation. A stopped/failed/archived Deployment is the
        // opposite case: the control plane decided this process must not run,
        // so a surviving unit is reaped below, never resurrected.
        const adopted = await store.adoptRuntimeInstance(
          deployment.id,
          {
            endpointHost: "127.0.0.1",
            endpointPort: deployment.hostPort,
          },
          now,
        );
        if (adopted) {
          await store.appendLog({
            projectId: deployment.projectId,
            deploymentId: deployment.id,
            type: "runtime",
            line: `Adopted unmanaged process ${name} as RuntimeInstance ${adopted.id}; the idle lifecycle now applies.`,
          });
        }
        firstSeenAt.delete(key);
        return 0;
      }
    }

    // Out-of-model: no Deployment row, an archived Deployment, or a process
    // running under a runtime kind that does not own the Deployment.
    const firstSeen = firstSeenAt.get(key) ?? now.getTime();
    firstSeenAt.set(key, firstSeen);
    if (now.getTime() - firstSeen < graceMs) return 0;
    await adapter.stopProcess(name);
    firstSeenAt.delete(key);
    if (deployment) {
      await store.appendLog({
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        type: "runtime",
        line:
          deployment.runtimeKind === kind
            ? `Stopped orphan process ${name} left behind by ${deployment.status} Deployment ${deployment.id}.`
            : `Stopped orphan ${kind} process ${name}; Deployment ${deployment.id} is owned by the ${deployment.runtimeKind} runtime.`,
      });
    } else {
      console.warn(`Stopped orphan ${kind} process ${name}: no Deployment record owns it.`);
    }
    return 1;
  }

  return async function reapOrphanProcesses(now: Date = new Date()): Promise<number> {
    let stopped = 0;
    const seenKeys = new Set<string>();
    for (const kind of kinds) {
      let names: string[];
      let adapter: RuntimeAdapter & ProcessDirectoryCapability;
      try {
        adapter = runtimeForKind(kind);
        names = await adapter.listProcesses(DEPLOYMENT_PROCESS_PREFIX);
      } catch {
        // Hosts legitimately lack the other runtime's CLI (docker-only dev,
        // systemd-only prod); a failed listing skips the kind, never the sweep.
        continue;
      }
      for (const name of names) {
        if (!deploymentProcessNamePattern.test(name)) continue;
        const key = `${kind}:${name}`;
        seenKeys.add(key);
        try {
          stopped += await sweepProcess(adapter, kind, name, key, now);
        } catch (error) {
          console.error(`Orphan sweep failed for ${kind} process ${name}:`, error);
        }
      }
    }
    if (kinds.includes("docker")) {
      try {
        const networks = await listOrphanDockerNetworks();
        for (const network of networks) {
          const key = `docker-network:${network.name}`;
          seenKeys.add(key);
          const firstSeen = firstSeenAt.get(key) ?? now.getTime();
          firstSeenAt.set(key, firstSeen);
          if (now.getTime() - firstSeen < graceMs) continue;
          try {
            if (await removeOrphanDockerNetwork(network)) {
              stopped += 1;
              firstSeenAt.delete(key);
              console.warn(
                `Removed orphan Docker Agent telemetry network ${network.name}: container ${network.processName} does not exist.`,
              );
            }
          } catch (error) {
            console.error(
              `Orphan sweep failed for Docker Agent telemetry network ${network.name}:`,
              error,
            );
          }
        }
      } catch {
        // Docker may be unavailable on a systemd-only host. Process cleanup
        // for other runtimes must continue independently.
      }
    }
    // A process that vanished between sweeps must not keep an aging grace
    // entry around to instantly condemn an unrelated future process reusing
    // its name.
    for (const key of firstSeenAt.keys()) {
      if (!seenKeys.has(key)) firstSeenAt.delete(key);
    }
    return stopped;
  };
}
