import type { ActivationLeaseClaim, ActivationLeaseKind, DeploymentRecord, RuntimeInstance, RuntimeKind } from "@eveland/core/contracts";
import { RuntimeInstanceDrainingError, type Store } from "@eveland/db";

// The narrow persistence port every activation-manager entry point shares.
export type ActivationStore = Pick<
  Store,
  | "acquireActivationLease"
  | "enqueueDeploymentActivation"
  | "failExpiredScheduleExecutions"
  | "failRunningSessionsForRuntimeInstance"
  | "failScheduleExecutionsForRuntimeInstance"
  | "getDeployment"
  | "getRuntimeInstance"
  | "listDeploymentRuntimeInstances"
  | "listReservedDeploymentHostPorts"
  | "listRuntimeInstances"
  | "releaseActivationLease"
  | "reserveRuntimeInstancePort"
  | "transitionDeploymentStatus"
  | "updateRuntimeInstance"
>;
import { waitForOwnedHttpHealth } from "./health.js";
import { allocateReservedInstancePort, isTcpPortAvailable } from "./ports.js";
import { createRuntimeAdapterForKind } from "./select.js";
import type { ProcessInspectionCapability, ProcessStartInput, RuntimeAdapter } from "./types.js";

export type DeploymentActivationInput = {
  deployment: DeploymentRecord;
  runtime: RuntimeAdapter;
  startInput: ProcessStartInput;
  kind: ActivationLeaseKind;
  ownerId: string;
};

export type DeploymentActivationOptions = {
  leaseTtlMs?: number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  drainRetryMs?: number;
  maxDrainRetryMs?: number;
  now?: () => Date;
  waitForHealth?: (input: { host: string; port: number; timeoutMs: number }) => Promise<void>;
};

export async function ensureDeploymentActive(
  store: ActivationStore,
  input: DeploymentActivationInput,
  options: DeploymentActivationOptions = {},
): Promise<ActivationLeaseClaim> {
  const now = options.now ?? (() => new Date());
  const leaseTtlMs = options.leaseTtlMs ?? 180_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const drainDeadline = Date.now() + readyTimeoutMs;
  let drainRetryMs = options.drainRetryMs ?? 25;
  const maxDrainRetryMs = options.maxDrainRetryMs ?? 500;
  let claimed: ActivationLeaseClaim;
  for (;;) {
    const attemptNow = now();
    try {
      claimed = await store.acquireActivationLease({
        deploymentId: input.deployment.id,
        kind: input.kind,
        ownerId: input.ownerId,
        expiresAt: new Date(attemptNow.getTime() + leaseTtlMs),
        now: attemptNow,
      });
      break;
    } catch (error) {
      if (!isRuntimeInstanceDrainingError(error)) throw error;
      const remainingMs = drainDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Runtime activation timed out after ${readyTimeoutMs}ms waiting for draining to finish.`);
      }
      await delay(Math.min(drainRetryMs, remainingMs));
      drainRetryMs = Math.min(maxDrainRetryMs, drainRetryMs * 2);
    }
  }

  // Ordered against the archive claim: whichever commits second sees the
  // other. An archive that claimed first is visible here; a lease acquired
  // first is visible to the archive's post-claim retention re-check.
  const liveDeployment = await store.getDeployment(input.deployment.id);
  if (
    !liveDeployment ||
    liveDeployment.status === "archiving" ||
    liveDeployment.status === "archived"
  ) {
    const refusal = liveDeployment
      ? `Deployment ${input.deployment.id} is ${liveDeployment.status} and cannot be activated.`
      : `Deployment ${input.deployment.id} no longer exists.`;
    if (claimed.starter) {
      await store.updateRuntimeInstance(claimed.runtimeInstance.id, {
        status: "failed",
        error: refusal,
      }, now());
    }
    await store.releaseActivationLease(claimed.lease.id, now());
    throw new Error(refusal);
  }

  if (claimed.runtimeInstance.status === "ready") return claimed;
  if (claimed.starter) {
    try {
      const ready = await startRuntimeInstance(store, input, claimed.runtimeInstance.id, options);
      return { ...claimed, runtimeInstance: ready };
    } catch (error) {
      await store.updateRuntimeInstance(claimed.runtimeInstance.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }, now());
      await store.releaseActivationLease(claimed.lease.id, now());
      throw error;
    }
  }

  try {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      const current = await store.getRuntimeInstance(claimed.runtimeInstance.id);
      if (!current) throw new Error("RuntimeInstance disappeared during activation.");
      if (current.status === "ready") return { ...claimed, runtimeInstance: current };
      if (current.status === "failed" || current.status === "stopped") {
        throw new Error(current.lastError ?? `Runtime activation ended in ${current.status}.`);
      }
      await delay(options.pollIntervalMs ?? 10);
    }
    throw new Error(`Runtime activation timed out after ${readyTimeoutMs}ms.`);
  } catch (error) {
    await store.releaseActivationLease(claimed.lease.id, now());
    throw error;
  }
}

/**
 * Resolves the loopback port this activation will start on and persists the
 * claim to the RuntimeInstance row BEFORE anything binds it. On systemd a
 * transient unit can start on any port, so a preferred port that cannot be
 * reserved (or is held by a foreign process) falls through to a fresh
 * allocation; a Docker container's published port is fixed at creation, so
 * Docker must reserve the Deployment's port or fail loudly.
 */
async function resolveInstancePort(
  store: ActivationStore,
  input: Pick<DeploymentActivationInput, "deployment" | "runtime" | "startInput">,
  current: RuntimeInstance,
): Promise<number> {
  // A recovered activation resumes an instance that already holds its
  // reservation -- the live-port index guarantees it is still exclusively ours.
  if (current.endpointPort !== null) return current.endpointPort;

  // Prefer the port the previous generation actually ran on (its still-active
  // unit binds that port, not necessarily deployments.host_port, which is a
  // first-deploy hint once instances reallocate).
  const priorInstances = await store.listDeploymentRuntimeInstances(input.deployment.id);
  const priorPort = [...priorInstances]
    .reverse()
    .find((instance) => instance.id !== current.id && instance.endpointPort !== null)?.endpointPort;
  const preferred = priorPort ?? input.deployment.hostPort;
  if (input.runtime.name !== "systemd") {
    if (await store.reserveRuntimeInstancePort(current.id, preferred)) return preferred;
    throw new Error(
      `Deployment port ${preferred} is reserved by another live RuntimeInstance and the ${input.runtime.name} ` +
        "runtime cannot rebind a Deployment to a different port.",
    );
  }

  // Adopt the preferred port when our own still-running unit already holds it
  // (scale-to-zero wake reusing an active unit); otherwise treat a bound
  // preferred port as unavailable.
  const ownership = input.runtime.verifyPortOwnership
    ? await input.runtime.verifyPortOwnership({
        processName: input.startInput.processName,
        port: preferred,
      })
    : { status: "unbound" as const };
  const preferredUsable =
    ownership.status === "owned" ||
    (ownership.status === "unbound" && (await isTcpPortAvailable("127.0.0.1", preferred)));
  return allocateReservedInstancePort(store, current.id, {
    ...(preferredUsable ? { preferredPort: preferred } : {}),
    dbReservedPorts: new Set(await store.listReservedDeploymentHostPorts()),
  });
}

export async function startRuntimeInstance(
  store: ActivationStore,
  input: Pick<DeploymentActivationInput, "deployment" | "runtime" | "startInput">,
  runtimeInstanceId: string,
  options: DeploymentActivationOptions = {},
): Promise<RuntimeInstance> {
  const now = options.now ?? (() => new Date());
  const current = await store.getRuntimeInstance(runtimeInstanceId);
  if (!current || current.deploymentId !== input.deployment.id) {
    throw new Error("RuntimeInstance does not belong to the requested Deployment.");
  }
  if (current.status === "ready") return current;
  if (current.status !== "starting") throw new Error(`RuntimeInstance cannot start from ${current.status}.`);
  try {
    const port = await resolveInstancePort(store, input, current);
    const start = input.runtime.ensureProcess?.bind(input.runtime) ?? input.runtime.startProcess.bind(input.runtime);
    await start({
      ...input.startInput,
      port,
      env: {
        ...input.startInput.env,
        EVELAND_RUNTIME_INSTANCE_ID: runtimeInstanceId,
      },
    });
    await waitForOwnedHttpHealth({
      host: "127.0.0.1",
      port,
      timeoutMs: options.readyTimeoutMs ?? 30_000,
      processName: input.startInput.processName,
      runtime: input.runtime,
      ...(options.waitForHealth ? { waitForHealth: options.waitForHealth } : {}),
    });
    const ready = await store.updateRuntimeInstance(runtimeInstanceId, {
      status: "ready",
      endpointHost: "127.0.0.1",
      endpointPort: port,
      error: null,
    }, now());
    if (!ready) throw new Error("RuntimeInstance disappeared during activation.");
    return ready;
  } catch (error) {
    await store.updateRuntimeInstance(runtimeInstanceId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }, now());
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRuntimeInstanceDrainingError(error: unknown): boolean {
  return error instanceof RuntimeInstanceDrainingError ||
    (error instanceof Error && error.message === "RuntimeInstance is draining; retry activation after it stops.");
}

export async function recoverStartingRuntimeInstances(
  store: ActivationStore,
  input: { now?: Date; limit?: number; staleJobAfterMs?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const instances = await store.listRuntimeInstances(["starting"], input.limit ?? 25);
  let recovered = 0;
  for (const instance of instances) {
    const deployment = await store.getDeployment(instance.deploymentId);
    if (!deployment) {
      await store.updateRuntimeInstance(instance.id, { status: "failed", error: "Deployment no longer exists." }, now);
      continue;
    }
    await store.enqueueDeploymentActivation(
      deployment.projectId,
      deployment.id,
      instance.id,
      now,
      input.staleJobAfterMs ?? 300_000,
    );
    recovered += 1;
  }
  return recovered;
}

/**
 * Re-reads a RuntimeInstance the caller inspected earlier and reports whether it
 * is still the live one. Inspection is slow (a Docker or systemd round trip), and
 * a restart_deployment job retires its live instances between its stop and its
 * health check -- so an instance that is no longer "ready" now belongs to whoever
 * retired it, and writing its Deployment status from a pre-inspection snapshot
 * would overwrite a healthy restart with a verdict about the process it replaced.
 */
async function stillReadyRuntimeInstance(
  store: ActivationStore,
  runtimeInstanceId: string,
): Promise<boolean> {
  const current = await store.getRuntimeInstance(runtimeInstanceId);
  return current?.status === "ready";
}

export async function reconcileRuntimeInstances(
  store: ActivationStore,
  input: {
    now?: Date;
    limit?: number;
    runtimeForKind?: (kind: RuntimeKind) => RuntimeAdapter & ProcessInspectionCapability;
  } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 100;
  const interruptedInstances = await store.listRuntimeInstances(
    ["stopped", "failed"],
    limit,
  );
  let reconciled = await store.failExpiredScheduleExecutions(now, limit);
  for (const instance of interruptedInstances) {
    const reason = `RuntimeInstance ${instance.id} ${instance.status} before its active Sessions reached a terminal boundary.`;
    const failedExecutions =
      await store.failScheduleExecutionsForRuntimeInstance(
        instance.id,
        reason,
        now,
      );
    const failedSessions = await store.failRunningSessionsForRuntimeInstance(
      instance.id,
      reason,
      now,
    );
    if (failedExecutions > 0 || failedSessions > 0) reconciled += 1;
  }
  const instances = await store.listRuntimeInstances(["ready"], limit);
  for (const instance of instances) {
    const deployment = await store.getDeployment(instance.deploymentId);
    if (!deployment) {
      await store.updateRuntimeInstance(instance.id, { status: "failed", error: "Deployment no longer exists." }, now);
      reconciled += 1;
      continue;
    }
    const runtime = (input.runtimeForKind ?? createRuntimeAdapterForKind)(deployment.runtimeKind);
    const status = await runtime.inspectProcess(deployment.containerName);
    if (status === "ready" || status === "starting") {
      if (!runtime.verifyPortOwnership) continue;
      // A live process is not enough: the incident mode behind cross-project
      // misrouting is a "ready" instance whose port is actually served by
      // another Deployment's process. Detect it and fail the instance loudly
      // instead of letting Gateway keep proxying to the wrong Agent.
      const ownership = await runtime.verifyPortOwnership({
        processName: deployment.containerName,
        port: instance.endpointPort ?? deployment.hostPort,
      });
      if (ownership.status !== "foreign") continue;
      if (!(await stillReadyRuntimeInstance(store, instance.id))) continue;
      const foreignReason =
        `RuntimeInstance ${instance.id} port ${instance.endpointPort ?? deployment.hostPort} is held by ` +
        `${ownership.holder}; its traffic was being served by a foreign process.`;
      await store.updateRuntimeInstance(instance.id, {
        status: "failed",
        error: foreignReason,
      }, now);
      // Only a live row is a sweeper's to write. archive_deployment leaves its
      // RuntimeInstance rows in place, so an unguarded write here un-archives a
      // retired Deployment; `draining` stays writable because a drained process
      // that dies is still this sweeper's to report.
      await store.transitionDeploymentStatus({
        deploymentId: deployment.id,
        to: "failed",
        from: ["running", "draining"],
      });
      await store.failScheduleExecutionsForRuntimeInstance(instance.id, foreignReason, now);
      await store.failRunningSessionsForRuntimeInstance(instance.id, foreignReason, now);
      reconciled += 1;
      continue;
    }
    if (!(await stillReadyRuntimeInstance(store, instance.id))) continue;
    const failed = status === "failed";
    await store.updateRuntimeInstance(instance.id, {
      status: failed ? "failed" : "stopped",
      error: failed ? "Runtime process inspection reported failure." : null,
    }, now);
    await store.transitionDeploymentStatus({
      deploymentId: deployment.id,
      to: failed ? "failed" : "stopped",
      from: ["running", "draining"],
    });
    const reason = `RuntimeInstance ${instance.id} ${failed ? "failed" : "stopped"} before its active Sessions reached a terminal boundary.`;
    await store.failScheduleExecutionsForRuntimeInstance(
      instance.id,
      reason,
      now,
    );
    await store.failRunningSessionsForRuntimeInstance(
      instance.id,
      reason,
      now,
    );
    reconciled += 1;
  }
  return reconciled;
}
