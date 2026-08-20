import type { ReleaseWorkflowAttestation } from "@evelandhq/core/contracts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The attestation a real build records for the pinned shared world. Fixture
 * deployments that expect to be restartable, activatable, or archivable must
 * state it — recordDeployment without attestation is `unknown`, which the
 * workflow topology gate fails closed by design.
 */
export const sharedWorkflowWorldAttestation: ReleaseWorkflowAttestation = {
  worldKind: "shared",
  worldPackage: "@evelandhq/workflow-world",
  worldVersion: "0.11.0",
  storageSpec: 6,
  dispatchProtocol: 1,
  enqueueCapability: "per_run_queue_v1",
};

/**
 * A fresh, ready dispatcher registration. Production deploys gate on this
 * machine-readable readiness, so production fixtures record one first.
 */
export async function recordReadyDispatcherFixture(
  store: {
    recordWorkflowDispatcherHeartbeat: (input: {
      instanceId: string;
      generation: string;
      state: "ready";
      ownershipAcquired: boolean;
      bootRecoveryCompleted: boolean;
      reenqueuedRuns: number | null;
      worldDatabaseIdentity: string;
      schemaGeneration: string | null;
      protocolMin: number;
      protocolMax: number;
      cutoverOperationId: string | null;
      unscopedRunnableJobs: number | null;
      unresolvedQuarantines: number | null;
      startedAt: string;
      readyAt: string | null;
    }) => Promise<unknown>;
  },
  worldDatabaseIdentity = "cluster:7234567890123456789/eveland_workflow",
): Promise<void> {
  await store.recordWorkflowDispatcherHeartbeat({
    instanceId: "wfd_fixture",
    generation: "eveland-workflow-dispatcher fixture",
    state: "ready",
    ownershipAcquired: true,
    bootRecoveryCompleted: true,
    reenqueuedRuns: 0,
    worldDatabaseIdentity,
    schemaGeneration: null,
    protocolMin: 1,
    protocolMax: 1,
    cutoverOperationId: null,
    unscopedRunnableJobs: 0,
    unresolvedQuarantines: 0,
    startedAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
  });
}

export async function createFixtureEveProject(eveVersion = "0.39.3"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-eve-"));
  await mkdir(path.join(root, "agent", "schedules"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture-agent",
      dependencies: { eve: eveVersion },
    }),
  );
  await writeFile(path.join(root, "agent", "instructions.md"), "You are concise.");
  await writeFile(
    path.join(root, "agent", "schedules", "daily.md"),
    '---\ncron: "0 8 * * *"\n---\nReport.',
  );
  return root;
}
