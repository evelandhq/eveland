import type { EvelandBuildInfo } from "@evelandhq/core/build-info";
import type { ActivationLeaseClaim } from "@evelandhq/core/contracts";
import {
  resolveSchedulerDispatchSecret,
  resolveSchedulerRuntimeSecret,
  verifyScheduleDispatchCredential,
} from "@evelandhq/core/server/scheduler-dispatch";
import type { Store } from "@evelandhq/db";
import { runtimeActivationSchema, schedulerDispatchSchema } from "./app-schemas.js";
import { isServiceRequest, safeSecretEqual, waitForRuntimeActivation } from "./app-support.js";
import type { ApiApp, AppOptions } from "./app-types.js";
import { registerOtlpRoutes } from "./app-otel-routes.js";
import { registerObservabilityProxyRoute } from "./app-observability-proxy-routes.js";

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
        parsed.data.status === "failed" ? (parsed.data.error ?? "Scheduled handler failed.") : null,
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
      return c.json({ lease: claim.lease, runtimeInstance });
    } catch (error) {
      await store.releaseActivationLease(claim.lease.id);
      if (c.req.raw.signal.aborted) {
        return new Response(JSON.stringify({ error: "Client closed activation request" }), {
          status: 499,
          headers: { "content-type": "application/json" },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
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
