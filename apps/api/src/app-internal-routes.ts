import type { EvelandBuildInfo } from "@evelandhq/core/build-info";
import type { ActivationLeaseClaim } from "@evelandhq/core/contracts";
import {
  isUnsupportedEveVersionMessage,
  unsupportedReleaseEveVersionMessage,
} from "@evelandhq/core/eve-compatibility";
import {
  resolveSchedulerDispatchSecret,
  resolveSchedulerRuntimeSecret,
  verifyScheduleDispatchCredential,
} from "@evelandhq/core/server/scheduler-dispatch";
import type { Store } from "@evelandhq/db";
import { resolveWorldClusterIdentity } from "@evelandhq/db/workflow-world-identity";
import { runtimeActivationSchema, schedulerDispatchSchema } from "./app-schemas.js";
import { isServiceRequest, safeSecretEqual, waitForRuntimeActivation } from "./app-support.js";
import type { ApiApp, AppOptions } from "./app-types.js";
import { registerOtlpRoutes } from "./app-otel-routes.js";
import { registerObservabilityProxyRoute } from "./app-observability-proxy-routes.js";
import {
  assessDispatcherReadiness,
  resolveDispatcherHeartbeatTtlMs,
  isSupportedWorkflowStorageSpec,
} from "@evelandhq/core/workflow-dispatch";
import { registerWorkflowDispatcherRoutes } from "./app-workflow-dispatcher-routes.js";

export function registerInternalRoutes(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
  buildInfo: EvelandBuildInfo;
  runtimeActivationLeaseTtlMs: number;
  runtimeActivationWaitTimeoutMs: number;
  appSecretKey: string;
}): void {
  const {
    app,
    store,
    options,
    buildInfo,
    runtimeActivationLeaseTtlMs,
    runtimeActivationWaitTimeoutMs,
  } = input;
  app.get("/health", (c) => c.json({ ok: true, ...buildInfo }));

  registerOtlpRoutes({ app, store, options, appSecretKey: input.appSecretKey });
  registerWorkflowDispatcherRoutes({ app, store, options });
  registerObservabilityProxyRoute({
    app,
    store,
    options,
    appSecretKey: input.appSecretKey,
  });

  app.post("/internal/scheduler/dispatch", async (c) => {
    const runtimeSecret =
      options.schedulerRuntimeSecret ?? resolveSchedulerRuntimeSecret(process.env);
    const dispatchSecret =
      options.schedulerDispatchSecret ?? resolveSchedulerDispatchSecret(process.env);
    if (!runtimeSecret || !dispatchSecret)
      return c.json({ error: "Scheduler dispatch is unavailable" }, 503);
    const suppliedRuntimeSecret = c.req.header("x-eveland-runtime-secret");
    if (!suppliedRuntimeSecret || !safeSecretEqual(runtimeSecret, suppliedRuntimeSecret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const parsed = schedulerDispatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid scheduler dispatch" }, 400);
    const credential = verifyScheduleDispatchCredential(
      parsed.data.credential,
      dispatchSecret,
      new Date(),
      { allowExpired: parsed.data.phase === "complete" },
    );
    if (
      !credential ||
      credential.scheduleRunId !== parsed.data.scheduleRunId ||
      credential.scheduleKey !== parsed.data.scheduleKey
    ) {
      return c.json({ error: "Dispatch rejected" }, 401);
    }
    const run = await store.getScheduleRun(parsed.data.scheduleRunId);
    const schedule = run ? await store.getProjectSchedule(run.scheduleId) : null;
    if (
      !run ||
      !schedule ||
      schedule.key !== parsed.data.scheduleKey ||
      run.deploymentId !== credential.deploymentId
    ) {
      return c.json({ error: "Dispatch not found" }, 404);
    }
    if (parsed.data.phase === "claim") {
      const claimed = await store.redeemScheduleRunDispatch(run.id, credential.deploymentId);
      return claimed ? c.json({ ok: true }) : c.json({ error: "Dispatch already claimed" }, 409);
    }
    if (run.status !== "dispatching") return c.json({ error: "Dispatch is not active" }, 409);
    const completed = await store.completeScheduleRun(run.id, {
      status: parsed.data.status,
      error:
        parsed.data.status === "succeeded"
          ? null
          : (parsed.data.error ??
            (parsed.data.status === "dispatch_unknown"
              ? "The dispatch outcome is unknown; the scheduled Session may still run."
              : "Scheduled handler failed.")),
      eveSessionIds: parsed.data.sessionIds,
    });
    return completed ? c.json({ ok: true }) : c.json({ error: "Dispatch not found" }, 404);
  });

  app.post("/internal/runtime/activations", async (c) => {
    const serviceToken = options.gatewayServiceToken ?? process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
    if (!isServiceRequest(c.req.header("authorization"), serviceToken))
      return c.json({ error: "Not found" }, 404);
    const parsed = runtimeActivationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid runtime activation" }, 400);
    const deployment = await store.getDeployment(parsed.data.deploymentId);
    if (!deployment || deployment.status === "archived" || deployment.status === "failed") {
      return c.json({ error: "Deployment is not activatable" }, 409);
    }
    // A Release pins the Eve version its build installed; once the supported
    // window slides past it, no start attempt can ever succeed. Refuse at
    // request time -- before a lease, RuntimeInstance generation, or worker
    // job exists -- instead of burning a doomed start on the worker's
    // serialized job lane per attempt and starving healthy activations
    // (issue #425). 409 is terminal to the workflow dispatcher: it
    // dead-letters the run, and boot recovery stops replaying it.
    const release = await store.getRelease(deployment.releaseId);
    const eveVersionRefusal = unsupportedReleaseEveVersionMessage(release?.summary ?? null);
    if (eveVersionRefusal !== null) return c.json({ error: eveVersionRefusal }, 409);
    // A workflow-step activation is only meaningful while the external
    // dispatcher can actually be proven ready — and only against a Release
    // whose attestation falls inside the dispatcher's protocol window with a
    // per-run-queue-capable enqueue path. Everything else fails fast with a
    // stable managed code instead of activating and timing out.
    let negotiated: { selectedProtocol: number; enqueueCapability: string } | undefined;
    if (parsed.data.kind === "workflow_step") {
      const registration = await store.getWorkflowDispatcherRegistration();
      // The dispatcher must be claiming from the same World this control
      // plane is configured for — proven by the cluster fingerprint both ends
      // read from the database itself, never by comparing URLs, which fails
      // open across unrelated servers. An unresolvable identity ("unknown")
      // fails closed, exactly like the worker's deploy gate.
      const expectedWorldIdentity =
        options.worldClusterIdentity ?? (await resolveWorldClusterIdentity(process.env));
      const readiness = assessDispatcherReadiness(registration, {
        ttlMs: resolveDispatcherHeartbeatTtlMs(process.env),
        expectedWorldDatabaseIdentity: expectedWorldIdentity,
      });
      if (!readiness.ready) return c.json({ error: readiness.reason }, 503);
      // Exact activation is bound to the registration this API validated: the
      // dispatcher sends its instance id, and a stale process sharing the
      // service token must not activate under another instance's registration.
      const callerInstance = c.req.header("x-eveland-dispatcher-instance");
      if (!callerInstance || callerInstance !== registration!.instanceId) {
        return c.json(
          {
            error: `workflow_unavailable: activation caller instance ${String(callerInstance)} does not match the validated dispatcher registration ${registration!.instanceId}`,
          },
          409,
        );
      }
      if (!release) return c.json({ error: "Deployment activation Release is missing" }, 409);
      const { workflow } = release;
      if (workflow.worldKind !== "shared") {
        return c.json(
          {
            error: `workflow_migration_required: Release ${release.id} is ${workflow.worldKind}, not a shared-world build`,
          },
          409,
        );
      }
      if (workflow.enqueueCapability !== "per_run_queue_v1") {
        return c.json(
          {
            error: `workflow_migration_required: Release ${release.id} enqueue capability is ${workflow.enqueueCapability}; shared recovery requires per_run_queue_v1`,
          },
          409,
        );
      }
      if (!isSupportedWorkflowStorageSpec(workflow.storageSpec)) {
        return c.json(
          {
            error: `workflow_migration_required: Release ${release.id} storage spec ${String(workflow.storageSpec)} is outside the supported window`,
          },
          409,
        );
      }
      if (
        workflow.dispatchProtocol === null ||
        workflow.dispatchProtocol < registration!.protocolMin ||
        workflow.dispatchProtocol > registration!.protocolMax
      ) {
        return c.json(
          {
            error: `workflow_migration_required: Release ${release.id} speaks dispatch protocol ${String(workflow.dispatchProtocol)}, outside the dispatcher window ${String(registration!.protocolMin)}-${String(registration!.protocolMax)}`,
          },
          409,
        );
      }
      negotiated = {
        selectedProtocol: Math.min(workflow.dispatchProtocol, registration!.protocolMax),
        enqueueCapability: workflow.enqueueCapability,
      };
    }
    const now = new Date();
    let claim: ActivationLeaseClaim;
    try {
      claim = await store.acquireActivationLease({
        deploymentId: deployment.id,
        kind: parsed.data.kind,
        ownerId: parsed.data.ownerId,
        expiresAt: new Date(now.getTime() + runtimeActivationLeaseTtlMs),
        now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, message.includes("draining") ? 425 : 503);
    }
    try {
      if (claim.runtimeInstance.status === "starting") {
        await store.enqueueDeploymentActivation(
          deployment.projectId,
          deployment.id,
          claim.runtimeInstance.id,
          now,
        );
      }
      const runtimeInstance = await (
        options.runtimeActivationWaiter ??
        ((candidate, input) => waitForRuntimeActivation(store, candidate, input))
      )(claim, {
        signal: c.req.raw.signal,
        timeoutMs: runtimeActivationWaitTimeoutMs,
      });
      if (runtimeInstance.status !== "ready" || runtimeInstance.endpointPort === null) {
        throw new Error("Runtime activation did not publish a ready endpoint.");
      }
      return c.json({
        lease: claim.lease,
        runtimeInstance,
        ...(negotiated ? { workflow: negotiated } : {}),
      });
    } catch (error) {
      await store.releaseActivationLease(claim.lease.id);
      if (c.req.raw.signal.aborted) {
        return new Response(JSON.stringify({ error: "Client closed activation request" }), {
          status: 499,
          headers: { "content-type": "application/json" },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      // The Eve version gate runs on every launch, so a deployment built under a
      // compatibility window that has since slid fails here forever. 503 reads as
      // "try again" to the workflow dispatcher, which burned three attempts and
      // three doomed runtime-instance generations per message before
      // dead-lettering. 409 is the terminal status it already understands, and
      // matches what the gateway returns for the same condition.
      if (isUnsupportedEveVersionMessage(message)) return c.json({ error: message }, 409);
      return c.json({ error: message }, message.includes("timed out") ? 504 : 503);
    }
  });

  app.post("/internal/runtime/activations/:leaseId/renew", async (c) => {
    const serviceToken = options.gatewayServiceToken ?? process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
    if (!isServiceRequest(c.req.header("authorization"), serviceToken))
      return c.json({ error: "Not found" }, 404);
    const now = new Date();
    const lease = await store.renewActivationLease(
      c.req.param("leaseId"),
      new Date(now.getTime() + runtimeActivationLeaseTtlMs),
      now,
    );
    return lease ? c.json({ lease }) : c.json({ error: "Activation lease is not renewable" }, 409);
  });

  app.delete("/internal/runtime/activations/:leaseId", async (c) => {
    const serviceToken = options.gatewayServiceToken ?? process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
    if (!isServiceRequest(c.req.header("authorization"), serviceToken))
      return c.json({ error: "Not found" }, 404);
    await store.releaseActivationLease(c.req.param("leaseId"));
    return c.body(null, 204);
  });
}
