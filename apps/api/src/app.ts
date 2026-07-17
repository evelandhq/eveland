import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { EvelandBuildInfo } from "@eveland/core/build-info";
import type {
  ActivationLeaseClaim,
  AuthPrincipal,
  LogRecord,
  RuntimeInstance,
  SessionStatus,
  TeamInvitation,
} from "@eveland/core/contracts";
import {
  getEveString,
  parseEveJsonObject,
  PLAYGROUND_MAX_TRANSPORT_BYTES,
  validatePlaygroundTurn,
} from "@eveland/core/eve";
import {
  createEveVersionInfo,
  readDeclaredEveVersion,
  unsupportedEveVersionMessage,
  type EveVersionInfo,
} from "@eveland/core/source";
import { assertSafeArchivePath } from "@eveland/core/server/archive";
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info";
import { assertValidSecretKey, encryptSecretValue } from "@eveland/core/server/secrets";
import {
  resolveSchedulerDispatchSecret,
  resolveSchedulerRuntimeSecret,
  verifyScheduleDispatchCredential,
} from "@eveland/core/server/scheduler-dispatch";
import {
  inferProjectSlugFromGitUrl,
  normalizeGitHttpHost,
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_PATTERN,
} from "@eveland/core/ids";
import { ProjectSlugConflictError, type Store } from "@eveland/db";
import type { CollectorHealth } from "@eveland/session-collector/health";
import type { SystemConfigurationDiagnostics } from "@eveland/core/config-diagnostics";
import { z } from "zod";
import {
  proxyGatewayPlayground,
  runGatewayPlayground,
  type PlaygroundProxy,
  type PlaygroundRunEvent,
  type PlaygroundRunner,
} from "./gateway-playground.js";
import { createBetterAuthRuntime } from "./auth.js";

const execFileAsync = promisify(execFile);

const projectNameSchema = z
  .string()
  .min(1)
  .max(PROJECT_SLUG_MAX_LENGTH)
  .regex(PROJECT_SLUG_PATTERN, "Use lowercase letters, numbers, and hyphens, with no leading or trailing hyphen.");

const gitRepositoryUrlSchema = z
  .string()
  .min(1)
  .refine((value) => inferProjectSlugFromGitUrl(value) !== null, "Enter a Git repository URL with a repository name.");

const createProjectSchema = z.discriminatedUnion("importKind", [
  z.object({
    name: projectNameSchema.optional(),
    importKind: z.literal("git"),
    gitUrl: gitRepositoryUrlSchema,
    gitlabPat: z.string().min(1).max(1024).optional(),
    deployAfterImport: z.boolean().optional(),
  }),
  z.object({
    name: projectNameSchema,
    importKind: z.literal("zip"),
    gitUrl: z.string().optional().nullable(),
    deployAfterImport: z.boolean().optional(),
  }),
]);

const environmentVariableSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Use uppercase letters, numbers, and underscores, starting with a letter."),
  value: z.string().min(1).max(65_536),
});

const createProjectFromPreflightSchema = z.object({
  name: projectNameSchema,
  preflightId: z.string().regex(/^pre_[0-9A-Za-z]+$/),
  deployAfterImport: z.boolean().optional(),
  environmentVariables: z.array(environmentVariableSchema).max(50).default([]),
}).superRefine((input, context) => {
  const keys = new Set<string>();
  input.environmentVariables.forEach((variable, index) => {
    if (keys.has(variable.key)) {
      context.addIssue({
        code: "custom",
        path: ["environmentVariables", index, "key"],
        message: "Environment variable keys must be unique.",
      });
    }
    keys.add(variable.key);
  });
});

const createGitSourcePreflightSchema = z.object({
  kind: z.literal("git"),
  gitUrl: gitRepositoryUrlSchema,
  gitlabPat: z.string().min(1).max(1024).optional(),
});

const secretSchema = environmentVariableSchema;

const playgroundMessageSchema = z.object({
  message: z.string().min(1),
});

const invitationSchema = z.object({
  email: z.email(),
});

const memberRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1),
  password: z.string().min(12),
});

const profileImageSchema = z.string().superRefine((value, context) => {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match?.[1]) {
    context.addIssue({ code: "custom", message: "Avatar must be a PNG, JPEG, or WebP image." });
    return;
  }
  if (Buffer.from(match[1], "base64").byteLength > 512 * 1024) {
    context.addIssue({ code: "custom", message: "Avatar must not exceed 512 KB." });
  }
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  image: profileImageSchema.nullable(),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(128),
});

const schedulerDispatchSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("claim"),
    credential: z.string().min(1),
    scheduleRunId: z.string().min(1),
    scheduleKey: z.string().min(1),
  }),
  z.object({
    phase: z.literal("complete"),
    credential: z.string().min(1),
    scheduleRunId: z.string().min(1),
    scheduleKey: z.string().min(1),
    sessionIds: z.array(z.string().min(1)),
    status: z.enum(["succeeded", "failed"]),
    error: z.string().min(1).max(2000).optional(),
  }),
]);

const runtimeActivationSchema = z.object({
  deploymentId: z.string().min(1),
  kind: z.enum(["public_request", "stream", "turn"]),
  ownerId: z.string().min(1).max(256),
});

const scheduleRunListQuerySchema = z.object({
  scheduleId: z.string().min(1).optional(),
  trigger: z.enum(["cron", "manual"]).optional(),
  status: z.enum(["queued", "activating", "dispatching", "running", "succeeded", "failed", "dispatch_unknown", "skipped"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const sessionListQuerySchema = z.object({
  trigger: z.enum(["playground", "api", "cron", "manual", "webhook", "channel", "direct_http"]).optional(),
  scheduleId: z.string().min(1).optional(),
  scheduleRunId: z.string().min(1).optional(),
  unlinkedOnly: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const targetsArraySchema = z.array(z.object({
    deploymentId: z.string().min(1),
    weight: z.number().int().min(0).max(10_000),
    variantName: z.string().min(1).nullable(),
  })).min(1).max(2);

const routeTargetsSchema = z.object({ targets: targetsArraySchema }).superRefine(validateTargetsPayload);
const aliasSchema = z.object({
  alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  targets: targetsArraySchema,
}).superRefine(validateTargetsPayload);

function validateTargetsPayload(
  value: { targets: Array<{ deploymentId: string; weight: number }> },
  context: z.RefinementCtx,
): void {
  if (value.targets.reduce((sum, target) => sum + target.weight, 0) !== 10_000) {
    context.addIssue({ code: "custom", path: ["targets"], message: "Route target weights must total 10,000." });
  }
  if (new Set(value.targets.map((target) => target.deploymentId)).size !== value.targets.length) {
    context.addIssue({ code: "custom", path: ["targets"], message: "Route target deployments must be unique." });
  }
}

const devSecretKey = "eveland-dev-secret-key-000000000";

type CreateGitCredentialInput = {
  userId: string;
  host: string;
  encryptedToken: string;
  persistAfterImport: boolean;
};

export type AppOptions = {
  buildInfo?: EvelandBuildInfo;
  auth?: ReturnType<typeof createBetterAuthRuntime>;
  webOrigin?: string;
  cookieDomain?: string;
  appSecretKey?: string;
  playgroundRunner?: PlaygroundRunner;
  playgroundProxy?: PlaygroundProxy;
  dataDir?: string;
  collectorHealth?: () => CollectorHealth;
  configurationDiagnostics?: () => Promise<SystemConfigurationDiagnostics>;
  gatewayPublicScheme?: "http" | "https";
  gatewayPublicPort?: number | null;
  invalidateGatewayRoutes?: (hostnames: string[]) => Promise<void>;
  schedulerDispatchSecret?: string;
  schedulerRuntimeSecret?: string;
  gatewayServiceToken?: string;
  runtimeActivationLeaseTtlMs?: number;
  runtimeActivationWaitTimeoutMs?: number;
  sourcePreflightTtlMs?: number;
  runtimeActivationWaiter?: (
    claim: ActivationLeaseClaim,
    input: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<RuntimeInstance>;
};

export function createApp(store: Store, options: AppOptions = {}): Hono<{ Variables: { principal: AuthPrincipal } }> {
  const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
  const buildInfo = options.buildInfo ?? createBuildInfoFromEnv("api", process.env);
  const runtimeActivationLeaseTtlMs = positiveDuration(
    options.runtimeActivationLeaseTtlMs ?? Number(process.env.EVELAND_ACTIVATION_LEASE_TTL_MS ?? 180_000),
    "runtime activation lease TTL",
  );
  const runtimeActivationWaitTimeoutMs = positiveDuration(
    options.runtimeActivationWaitTimeoutMs ?? Number(process.env.EVELAND_COLD_START_TIMEOUT_MS ?? 30_000),
    "runtime activation wait timeout",
  );
  const sourcePreflightTtlMs = positiveDuration(
    options.sourcePreflightTtlMs ?? Number(process.env.EVELAND_SOURCE_PREFLIGHT_TTL_MS ?? 3_600_000),
    "source preflight TTL",
  );
  if (!options.auth && process.env.NODE_ENV !== "test") {
    throw new Error("Control-plane authentication is required outside tests.");
  }
  const appSecretKey = options.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey;
  assertValidSecretKey(appSecretKey);
  const playgroundRunner = options.playgroundRunner ?? runGatewayPlayground;
  const playgroundProxy = options.playgroundProxy ?? proxyGatewayPlayground;
  const dataDir = options.dataDir ?? process.env.EVELAND_DATA_DIR ?? ".eveland-data";
  const webOrigin = options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const enqueueLiveDeploymentRestarts = async (projectId: string) => {
    const deployments = (await store.listDeployments(projectId)).filter(
      (deployment) => deployment.status === "running" || deployment.status === "draining",
    );
    return Promise.all(
      deployments.map((deployment) =>
        store.enqueueJob(projectId, "restart_deployment", {
          deploymentId: deployment.id,
          reason: "secret_changed",
        }),
      ),
    );
  };

  app.use(
    "*",
    cors({
      origin: webOrigin,
      credentials: true,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, ...buildInfo }));

  app.get("/internal/collector/health", (c) =>
    c.json(
      options.collectorHealth?.() ?? {
        status: "healthy",
        lastProcessedAt: null,
        backlogEvents: 0,
        backlogBytes: 0,
        oldestEventAge: 0,
        quarantinedEvents: 0,
        lastError: null,
        mode: "disabled",
      },
    ),
  );

  app.post("/internal/scheduler/dispatch", async (c) => {
    const runtimeSecret = options.schedulerRuntimeSecret ?? resolveSchedulerRuntimeSecret(process.env);
    const dispatchSecret = options.schedulerDispatchSecret ?? resolveSchedulerDispatchSecret(process.env);
    if (!runtimeSecret || !dispatchSecret) return c.json({ error: "Scheduler dispatch is unavailable" }, 503);
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
      error: parsed.data.status === "failed" ? (parsed.data.error ?? "Scheduled handler failed.") : null,
      eveSessionIds: parsed.data.sessionIds,
    });
    return completed ? c.json({ ok: true }) : c.json({ error: "Dispatch not found" }, 404);
  });

  app.post("/internal/runtime/activations", async (c) => {
    const serviceToken = options.gatewayServiceToken ?? process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
    if (!isServiceRequest(c.req.header("authorization"), serviceToken)) return c.json({ error: "Not found" }, 404);
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
        await store.enqueueDeploymentActivation(deployment.projectId, deployment.id, claim.runtimeInstance.id, now);
      }
      const runtimeInstance = await (options.runtimeActivationWaiter ?? ((candidate, input) =>
        waitForRuntimeActivation(store, candidate, input)))(claim, {
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
    if (!isServiceRequest(c.req.header("authorization"), serviceToken)) return c.json({ error: "Not found" }, 404);
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
    if (!isServiceRequest(c.req.header("authorization"), serviceToken)) return c.json({ error: "Not found" }, 404);
    await store.releaseActivationLease(c.req.param("leaseId"));
    return c.body(null, 204);
  });

  if (options.auth) {
    app.on(["GET", "POST"], "/api/auth/*", (c) => {
      const path = new URL(c.req.url).pathname;
      if (
        path.startsWith("/api/auth/sign-up/") ||
        path.startsWith("/api/auth/admin/") ||
        path.startsWith("/api/auth/organization/") ||
        path === "/api/auth/update-user"
      ) {
        return c.notFound();
      }
      return options.auth!.handler(c.req.raw);
    });

    app.post("/invitations/accept", async (c) => {
      const parsed = acceptInvitationSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid invitation acceptance", issues: parsed.error.issues }, 400);
      try {
        const session = await options.auth!.acceptInvitation(parsed.data);
        for (const cookie of getSetCookies(session.headers)) c.header("set-cookie", cookie, { append: true });
        return c.json({ member: session.principal });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.use("*", async (c, next) => {
      const principal = await options.auth!.authenticate(c.req.raw);
      if (!principal) return c.json({ error: "Authentication required" }, 401);
      c.set("principal", principal);
      await next();
    });

    app.get("/auth/session", (c) => c.json({ member: c.get("principal") }));

    app.get("/system/configuration", async (c) => {
      if (c.get("principal").role !== "admin") return c.json({ error: "Admin access required" }, 403);
      if (!options.configurationDiagnostics) return c.json({ error: "Configuration diagnostics unavailable" }, 503);
      try {
        return c.json(await options.configurationDiagnostics());
      } catch {
        return c.json({ error: "Configuration diagnostics unavailable" }, 503);
      }
    });

    app.patch("/profile", async (c) => {
      const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid profile", issues: parsed.error.issues }, 400);
      try {
        const updated = await options.auth!.updateProfile(c.req.raw, parsed.data);
        for (const cookie of getSetCookies(updated.headers)) c.header("set-cookie", cookie, { append: true });
        return c.json({ member: updated.principal });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.post("/profile/password", async (c) => {
      const parsed = passwordChangeSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid password change", issues: parsed.error.issues }, 400);
      try {
        const headers = await options.auth!.changePassword(c.req.raw, parsed.data);
        for (const cookie of getSetCookies(headers)) c.header("set-cookie", cookie, { append: true });
        return c.body(null, 204);
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.get("/members", async (c) => c.json({ members: await options.auth!.listMembers(c.req.raw) }));

    app.get("/invitations", async (c) => {
      try {
        const invitations = await options.auth!.listInvitations(c.req.raw);
        return c.json({ invitations: invitations.map(publicInvitation) });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.post("/invitations", async (c) => {
      const parsed = invitationSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid invitation input", issues: parsed.error.issues }, 400);
      try {
        const issued = await options.auth!.invite(c.req.raw, parsed.data.email);
        return c.json(
          {
            invitation: publicInvitation(issued.invitation),
            inviteUrl: `${webOrigin}/accept-invite?token=${encodeURIComponent(issued.token)}`,
          },
          201,
        );
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.post("/invitations/:invitationId/resend", async (c) => {
      try {
        const issued = await options.auth!.reissueInvitation(c.req.raw, c.req.param("invitationId"));
        return c.json({
          invitation: publicInvitation(issued.invitation),
          inviteUrl: `${webOrigin}/accept-invite?token=${encodeURIComponent(issued.token)}`,
        });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.delete("/invitations/:invitationId", async (c) => {
      try {
        const revoked = await options.auth!.revokeInvitation(c.req.raw, c.req.param("invitationId"));
        return revoked ? c.body(null, 204) : c.json({ error: "Invitation not found" }, 404);
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.patch("/members/:userId", async (c) => {
      const parsed = memberRoleSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid member role" }, 400);
      try {
        const member = await options.auth!.updateMemberRole(c.req.raw, c.req.param("userId"), parsed.data.role);
        return c.json({ member });
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });

    app.delete("/members/:userId", async (c) => {
      try {
        const removed = await options.auth!.removeMember(c.req.raw, c.req.param("userId"));
        return removed ? c.body(null, 204) : c.json({ error: "Member not found" }, 404);
      } catch (error) {
        return authErrorResponse(c, error);
      }
    });
  }

  const rejectProjectMutationsWhileDeleting: MiddlewareHandler = async (c, next) => {
    const method = c.req.method;
    const projectDelete = method === "DELETE" && /^\/projects\/[^/]+\/?$/.test(new URL(c.req.url).pathname);
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || projectDelete) {
      await next();
      return;
    }

    const projectId = c.req.param("projectId");
    if (!projectId) {
      await next();
      return;
    }
    const project = await store.getProject(projectId);
    if (project?.deletionStatus === "deleting") {
      return c.json({ error: "Project is being deleted" }, 409);
    }
    await next();
  };
  app.use("/projects/:projectId", rejectProjectMutationsWhileDeleting);
  app.use("/projects/:projectId/*", rejectProjectMutationsWhileDeleting);

  app.get("/projects", async (c) => c.json({ projects: await store.listProjects() }));

  app.get("/projects/name-availability", async (c) => {
    const parsed = projectNameSchema.safeParse(c.req.query("name"));
    if (!parsed.success) {
      return c.json({ error: "Invalid project name", issues: parsed.error.issues }, 400);
    }
    return c.json({ available: await store.isProjectSlugAvailable(parsed.data) });
  });

  app.get("/git-credentials", async (c) => {
    return c.json({ credentials: await store.listGitCredentials(currentUserId(c)) });
  });

  app.delete("/git-credentials/:credentialId", async (c) => {
    const deleted = await store.deleteGitCredential(currentUserId(c), c.req.param("credentialId"));
    return deleted ? c.body(null, 204) : c.json({ error: "Git credential not found" }, 404);
  });

  app.post("/source-preflights", async (c) => {
    const expiresAt = new Date(Date.now() + sourcePreflightTtlMs);
    if (isMultipartRequest(c)) {
      const form = await c.req.formData();
      const archive = form.get("archive");
      if (!(archive instanceof File) || archive.size === 0) {
        return c.json({ error: "Invalid zip upload", issues: [{ path: ["archive"], message: "Source archive is required" }] }, 400);
      }
      const { sourcePath, uploadDir } = await extractZipUpload(archive, dataDir);
      try {
        const preflight = await store.createSourcePreflight({
          userId: currentUserId(c),
          kind: "zip",
          sourcePath,
          expiresAt,
        });
        return c.json({ preflight }, 202);
      } catch (error) {
        await rm(uploadDir, { recursive: true, force: true });
        throw error;
      }
    }

    const parsed = createGitSourcePreflightSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid source preflight input", issues: parsed.error.issues }, 400);
    const userId = currentUserId(c);
    const host = normalizeGitHttpHost(parsed.data.gitUrl);
    if (parsed.data.gitlabPat && !host) {
      return c.json({ error: "GitLab PAT authentication requires an HTTPS repository URL without embedded credentials." }, 400);
    }
    const stored = host && !parsed.data.gitlabPat ? await store.getGitCredential(userId, host) : null;
    const gitCredential: CreateGitCredentialInput | undefined = parsed.data.gitlabPat && host
      ? {
          userId,
          host,
          encryptedToken: JSON.stringify(encryptSecretValue(parsed.data.gitlabPat, appSecretKey)),
          persistAfterImport: true,
        }
      : stored
        ? {
            userId,
            host: stored.host,
            encryptedToken: stored.encryptedToken,
            persistAfterImport: false,
          }
        : undefined;
    const preflight = await store.createSourcePreflight({
      userId,
      kind: "git",
      gitUrl: parsed.data.gitUrl,
      expiresAt,
      ...(gitCredential ? { gitCredential } : {}),
    });
    return c.json({ preflight }, 202);
  });

  app.get("/source-preflights/:preflightId", async (c) => {
    const preflight = await store.getSourcePreflight(c.req.param("preflightId"), currentUserId(c));
    return preflight ? c.json({ preflight }) : c.json({ error: "Source preflight not found" }, 404);
  });

  app.post("/projects", async (c) => {
    if (isMultipartRequest(c)) {
      return createZipProjectFromUpload(c, store, dataDir);
    }

    const input = await c.req.json().catch(() => null);
    if (typeof input === "object" && input !== null && "preflightId" in input) {
      const parsedPreflight = createProjectFromPreflightSchema.safeParse(input);
      if (!parsedPreflight.success) {
        return c.json({ error: "Invalid project input", issues: parsedPreflight.error.issues }, 400);
      }
      try {
        const { environmentVariables, ...projectInput } = parsedPreflight.data;
        const result = await store.createProjectFromSourcePreflight({
          ...projectInput,
          userId: currentUserId(c),
          secrets: environmentVariables.map((variable) => ({
            key: variable.key,
            encryptedValue: JSON.stringify(encryptSecretValue(variable.value, appSecretKey)),
          })),
        });
        if (result.outcome === "not_found") return c.json({ error: "Source preflight not found" }, 404);
        if (result.outcome === "not_ready") return c.json({ error: "Source preflight is not ready" }, 409);
        if (result.outcome === "consumed") return c.json({ error: "Source preflight has already been used" }, 409);
        return c.json({ project: result.project }, 201);
      } catch (error) {
        if (error instanceof ProjectSlugConflictError) return c.json({ error: error.message }, 409);
        throw error;
      }
    }

    const parsed = createProjectSchema.safeParse(input);
    if (!parsed.success) {
      return c.json({ error: "Invalid project input", issues: parsed.error.issues }, 400);
    }

    const name =
      parsed.data.importKind === "git"
        ? parsed.data.name ?? inferProjectSlugFromGitUrl(parsed.data.gitUrl)
        : parsed.data.name;
    if (!name) {
      return c.json({ error: "Invalid project input" }, 400);
    }
    let gitCredential: CreateGitCredentialInput | undefined;
    if (parsed.data.importKind === "git") {
      const host = normalizeGitHttpHost(parsed.data.gitUrl);
      if (parsed.data.gitlabPat && !host) {
        return c.json({ error: "GitLab PAT authentication requires an HTTPS repository URL without embedded credentials." }, 400);
      }
      if (host) {
        const userId = currentUserId(c);
        const stored = parsed.data.gitlabPat ? null : await store.getGitCredential(userId, host);
        if (parsed.data.gitlabPat) {
          gitCredential = {
            userId,
            host,
            encryptedToken: JSON.stringify(encryptSecretValue(parsed.data.gitlabPat, appSecretKey)),
            persistAfterImport: true,
          };
        } else if (stored) {
          gitCredential = {
            userId,
            host,
            encryptedToken: stored.encryptedToken,
            persistAfterImport: false,
          };
        }
      }
    }
    try {
      const project = parsed.data.importKind === "git"
        ? await store.createProject({
            name,
            importKind: "git",
            gitUrl: parsed.data.gitUrl,
            requireExactSlug: true,
            deployAfterImport: parsed.data.deployAfterImport,
            ...(gitCredential ? { gitCredential } : {}),
          })
        : await store.createProject({ ...parsed.data, name, requireExactSlug: true });
      return c.json({ project }, 201);
    } catch (error) {
      if (error instanceof ProjectSlugConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await store.getProject(c.req.param("projectId"));
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json({ project });
  });

  app.get("/projects/:projectId/jobs", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const projectJobs = c.req.query("include") === "deployment"
      ? await store.listProjectJobs(projectId, { limit: 50 })
      : await store.listProjectJobs(projectId, { type: "import_source" });
    return c.json({
      jobs: projectJobs.map((job) => ({ ...job, payload: {} })),
    });
  });

  app.get("/projects/:projectId/endpoints", async (c) => {
    const routes = await store.listProjectRoutes(c.req.param("projectId"));
    if (routes.length === 0) return c.json({ error: "Agent endpoints not found" }, 404);
    const scheme = options.gatewayPublicScheme ?? (process.env.EVELAND_GATEWAY_PUBLIC_SCHEME === "https" ? "https" : "http");
    const configuredPort = options.gatewayPublicPort ?? Number(process.env.EVELAND_GATEWAY_PUBLIC_PORT ?? (scheme === "http" ? 4080 : 0));
    const suffix = configuredPort ? `:${configuredPort}` : "";
    const url = (hostname: string) => `${scheme}://${hostname}${suffix}`;
    return c.json({
      stable: routes.find((route) => route.kind === "project") ? url(routes.find((route) => route.kind === "project")!.hostname) : null,
      previews: routes.filter((route) => route.kind === "deployment").map((route) => url(route.hostname)).sort(),
    });
  });

  app.get("/projects/:projectId/deployments", async (c) => {
    const projectId = c.req.param("projectId");
    const [deployments, retention, routes] = await Promise.all([
      store.listDeployments(projectId), store.getDeploymentRetention(projectId), store.listProjectRoutes(projectId),
    ]);
    return c.json({ deployments, retention, routes });
  });

  app.get("/projects/:projectId/variant-metrics", async (c) => {
    const sessions = await store.listSessions(c.req.param("projectId"));
    const groups = new Map<string, {
      deploymentId: string | null;
      experimentId: string | null;
      variantName: string;
      sessions: number;
      success: number;
      failure: number;
      latencyMs: number;
      latencySamples: number;
      tokens: number;
      costUsd: number;
    }>();
    for (const session of sessions) {
      const variantName = session.variantName ?? "unassigned";
      const groupKey = JSON.stringify([session.deploymentId, session.experimentId, variantName]);
      const group = groups.get(groupKey) ?? {
        deploymentId: session.deploymentId,
        experimentId: session.experimentId,
        variantName,
        sessions: 0,
        success: 0,
        failure: 0,
        latencyMs: 0,
        latencySamples: 0,
        tokens: 0,
        costUsd: 0,
      };
      group.sessions += 1;
      if (session.status === "completed") group.success += 1;
      if (session.status === "failed") group.failure += 1;
      if (session.completedAt) {
        group.latencyMs += Math.max(0, Date.parse(session.completedAt) - Date.parse(session.startedAt));
        group.latencySamples += 1;
      }
      group.tokens += session.usage.inputTokens + session.usage.outputTokens + session.usage.cacheReadTokens + session.usage.cacheWriteTokens;
      group.costUsd += session.usage.costUsd ?? 0;
      groups.set(groupKey, group);
    }
    return c.json({ variants: [...groups.values()].map(({ latencyMs, latencySamples, ...group }) => ({
      ...group,
      averageLatencyMs: latencySamples ? latencyMs / latencySamples : 0,
    })) });
  });

  app.post("/projects/:projectId/deployments/:deploymentId/promote", async (c) => {
    const route = await store.promoteDeployment(c.req.param("projectId"), c.req.param("deploymentId"));
    await invalidateGateway(options, [route.hostname]);
    return c.json({ route });
  });

  app.post("/projects/:projectId/deployments/:deploymentId/drain", async (c) => {
    const deployment = await store.getDeployment(c.req.param("deploymentId"));
    if (!deployment || deployment.projectId !== c.req.param("projectId")) return c.json({ error: "Deployment not found" }, 404);
    const routes = await store.listProjectRoutes(deployment.projectId);
    if (routes.some((route) => route.kind !== "deployment" && route.targets.some((target) => target.deploymentId === deployment.id && target.weight > 0))) {
      return c.json({ error: "Set this deployment route weight to zero before draining." }, 409);
    }
    const updated = await store.updateDeploymentStatus(deployment.id, "draining");
    return c.json({ deployment: updated });
  });

  app.post("/projects/:projectId/deployments/:deploymentId/archive", async (c) => {
    const projectId = c.req.param("projectId");
    const deploymentId = c.req.param("deploymentId");
    const policy = (await store.getDeploymentRetention(projectId)).find((entry) => entry.deployment.id === deploymentId);
    if (!policy) return c.json({ error: "Deployment not found" }, 404);
    if (policy.protected) return c.json({ error: "Deployment is protected from archive", reasons: policy.reasons }, 409);
    const job = await store.enqueueJob(projectId, "archive_deployment", { deploymentId });
    return c.json({ job }, 202);
  });

  app.put("/projects/:projectId/routes/:routeId/targets", async (c) => {
    const input = routeTargetsSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Invalid route targets", detail: input.error.flatten() }, 400);
    const routes = await store.listProjectRoutes(c.req.param("projectId"));
    const existing = routes.find((route) => route.id === c.req.param("routeId"));
    if (!existing) return c.json({ error: "Route not found" }, 404);
    if (existing.kind === "deployment") return c.json({ error: "Deployment preview routes are immutable" }, 409);
    const route = await store.updateRouteTargets(c.req.param("routeId"), input.data.targets);
    await invalidateGateway(options, [route.hostname]);
    return c.json({ route });
  });

  app.post("/projects/:projectId/aliases", async (c) => {
    const input = aliasSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Invalid alias route", detail: input.error.flatten() }, 400);
    const baseDomain = (process.env.EVELAND_AGENT_BASE_DOMAINS ?? "agent.localhost").split(",")[0]!.trim();
    const route = await store.ensureAliasRoute(c.req.param("projectId"), input.data.alias, baseDomain, input.data.targets);
    await invalidateGateway(options, [route.hostname]);
    return c.json({ route }, 201);
  });

  app.delete("/projects/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const request = await store.requestProjectDeletion(projectId);
    if (request.outcome === "not_found") return c.json({ error: "Project not found" }, 404);
    if (request.outcome === "already_deleting") return c.json({ error: "Project is being deleted" }, 409);
    return c.json({ job: { ...request.job, payload: {} } }, 202);
  });

  app.post("/projects/:projectId/build-deploy", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const job = await store.enqueueJob(projectId, "build_deploy");
    return c.json({ job }, 202);
  });

  app.post("/projects/:projectId/sync-source", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (project.importKind !== "git" || !project.gitUrl) {
      return c.json({ error: "Only git projects can sync source from a repository." }, 400);
    }

    const deploy = await readSyncDeployFlag(c);
    const host = normalizeGitHttpHost(project.gitUrl);
    const storedCredential = host ? await store.getGitCredential(currentUserId(c), host) : null;
    const job = await store.enqueueJob(projectId, "import_source", {
      importKind: "git",
      gitUrl: project.gitUrl,
      deployAfterImport: deploy,
      ...(storedCredential ? {
        gitCredential: {
          userId: storedCredential.userId,
          host: storedCredential.host,
          encryptedToken: storedCredential.encryptedToken,
          persistAfterImport: false,
        },
      } : {}),
    });
    return c.json({ job }, 202);
  });

  app.post("/projects/:projectId/restart", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const job = await store.enqueueJob(projectId, "restart_deployment");
    return c.json({ job }, 202);
  });

  app.all("/projects/:projectId/playground/eve/*", async (c) => {
    const projectId = c.req.param("projectId");
    const requestUrl = new URL(c.req.url);
    const playgroundMarker = "/playground";
    const markerIndex = requestUrl.pathname.indexOf(playgroundMarker);
    const evePath = markerIndex >= 0 ? requestUrl.pathname.slice(markerIndex + playgroundMarker.length) : "";
    const pathSessionId = playgroundSessionIdFromPath(evePath);
    const isInitial = c.req.method === "POST" && evePath === "/eve/v1/session";
    const isContinuation = c.req.method === "POST" && /^\/eve\/v1\/session\/[^/]+$/.test(evePath);
    const isCancel = c.req.method === "POST" && /^\/eve\/v1\/session\/[^/]+\/cancel$/.test(evePath);
    const isStream = c.req.method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream$/.test(evePath);
    if (!isInitial && !isContinuation && !isCancel && !isStream) return c.json({ error: "Playground route not found" }, 404);

    const project = await store.getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    let platformSession = pathSessionId ? await store.getSessionByEveSessionId(projectId, pathSessionId) : null;
    if (pathSessionId && !platformSession) return c.json({ error: "Playground session not found" }, 404);
    const eveVersion = platformSession?.deploymentId
      ? await resolveProjectEveVersion(store, projectId, platformSession.deploymentId)
      : null;
    if (eveVersion && !eveVersion.supported) {
      return c.json({
        error: "Unsupported Eve version",
        detail: unsupportedEveVersionMessage(eveVersion.version),
        eveVersion,
      }, 409);
    }

    let body: Uint8Array | null = null;
    if (isInitial || isContinuation || isCancel) {
      try {
        body = await readLimitedPlaygroundBody(c.req.raw, PLAYGROUND_MAX_TRANSPORT_BYTES);
        if (!isCancel) validatePlaygroundTurn(parsePlaygroundBody(body));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid Playground request";
        const status = message === "Playground request body is too large." ? 413 : 400;
        return c.json({ error: message }, status);
      }
    }

    if (isInitial) {
      platformSession = await store.createSession({ projectId, deploymentId: null, trigger: "playground" });
    }

    let upstream: Response;
    try {
      upstream = await playgroundProxy({
        projectId,
        path: `${evePath}${requestUrl.search}`,
        method: c.req.method,
        headers: c.req.raw.headers,
        body,
        signal: c.req.raw.signal,
      });
    } catch (error) {
      if (platformSession && !isCancel) {
        await store.completeSession(platformSession.id, { status: "failed", eveSessionId: pathSessionId });
      }
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Playground request failed", detail: message }, 502);
    }

    if (!upstream.ok && platformSession && !isCancel) {
      await store.completeSession(platformSession.id, { status: "failed", eveSessionId: pathSessionId });
    }

    if ((isInitial || isContinuation) && upstream.ok && platformSession) {
      const parsed = await parsePlaygroundResponse(upstream.clone());
      const eveSessionId = upstream.headers.get("x-eve-session-id") ?? getEveString(parsed, "sessionId") ?? pathSessionId;
      await store.completeSession(platformSession.id, {
        status: "running",
        eveSessionId,
        continuationToken: getEveString(parsed, "continuationToken"),
      });
    }

    const responseBody = isStream && upstream.ok && upstream.body && platformSession && pathSessionId
      ? monitorPlaygroundStream(upstream.body, store, platformSession.id, pathSessionId)
      : upstream.body;
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });

  app.post("/projects/:projectId/playground", async (c) => {
    const projectId = c.req.param("projectId");
    const parsed = playgroundMessageSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid playground message", issues: parsed.error.issues }, 400);
    }

    const project = await store.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const deployment = await store.getCurrentDeployment(projectId);
    if (!deployment || (deployment.status !== "running" && deployment.status !== "stopped")) {
      return c.json({ error: "No running deployment" }, 409);
    }
    const eveVersion = await resolveProjectEveVersion(store, projectId, deployment.id);
    if (!eveVersion.supported) {
      return c.json({
        error: "Unsupported Eve version",
        detail: unsupportedEveVersionMessage(eveVersion.version),
        eveVersion,
      }, 409);
    }

    const session = await store.createSession({
      projectId,
      deploymentId: deployment.id,
      trigger: "playground",
      scheduleId: null,
    });
    await store.appendSessionEvent(session.id, "message", { role: "user", content: parsed.data.message });

    try {
      let eventPersistence = Promise.resolve();
      const persistEvent = (event: PlaygroundRunEvent) => {
        const queued = eventPersistence.then(async () => {
          await store.appendSessionEvent(session.id, event.type, event.payload);
        });
        eventPersistence = queued.catch(() => undefined);
        return queued;
      };
      const result = await playgroundRunner({ project, deployment, message: parsed.data.message, onEvent: persistEvent });
      for (const event of result.events ?? [{ type: "model_response", payload: { content: result.response } }]) {
        await persistEvent(event);
      }
      const completed = await store.completeSession(session.id, {
        status: result.status ?? "waiting",
        eveSessionId: result.eveSessionId ?? null,
        continuationToken: result.continuationToken ?? null,
      });
      return c.json({ session: completed, events: await store.listSessionEvents(session.id) }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.appendSessionEvent(session.id, "error", { message });
      const failed = await store.completeSession(session.id, { status: "failed" });
      return c.json({ error: "Playground request failed", detail: message, session: failed, events: await store.listSessionEvents(session.id) }, 502);
    }
  });

  app.get("/projects/:projectId/secrets", async (c) => {
    return c.json({ secrets: await store.listSecrets(c.req.param("projectId")) });
  });

  app.post("/projects/:projectId/secrets", async (c) => {
    const parsed = secretSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid secret input", issues: parsed.error.issues }, 400);
    }
    const encrypted = encryptSecretValue(parsed.data.value, appSecretKey);
    const projectId = c.req.param("projectId");
    const secret = await store.upsertSecret(projectId, parsed.data.key, JSON.stringify(encrypted));
    const jobs = await enqueueLiveDeploymentRestarts(projectId);
    return c.json({ secret, jobs }, 201);
  });

  app.delete("/projects/:projectId/secrets/:secretId", async (c) => {
    const projectId = c.req.param("projectId");
    const deleted = await store.deleteSecret(projectId, c.req.param("secretId"));
    const jobs = deleted ? await enqueueLiveDeploymentRestarts(projectId) : [];
    return c.json({ deleted, jobs });
  });

  app.get("/projects/:projectId/schedules", async (c) => {
    return c.json({ schedules: await store.listProjectScheduleSummaries(c.req.param("projectId")) });
  });

  app.post("/projects/:projectId/schedules/:scheduleId/runs", async (c) => {
    try {
      const run = await store.createManualScheduleRun(c.req.param("projectId"), c.req.param("scheduleId"));
      return c.json({ run }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, message === "Project schedule not found." ? 404 : 409);
    }
  });

  app.get("/projects/:projectId/schedule-runs", async (c) => {
    const parsed = scheduleRunListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid schedule-run filters", issues: parsed.error.issues }, 400);
    const page = await store.listScheduleRuns(c.req.param("projectId"), parsed.data);
    return c.json({ runs: page.items, nextCursor: page.nextCursor });
  });

  app.get("/schedule-runs/:scheduleRunId", async (c) => {
    const run = await store.getScheduleRunDetail(c.req.param("scheduleRunId"));
    return run ? c.json({ run }) : c.json({ error: "ScheduleRun not found" }, 404);
  });

  app.get("/projects/:projectId/source/revision", async (c) => {
    return c.json({ revision: await store.getCurrentSourceRevision(c.req.param("projectId")) });
  });

  app.get("/projects/:projectId/eve-version", async (c) => {
    const projectId = c.req.param("projectId");
    if (!(await store.getProject(projectId))) return c.json({ error: "Project not found" }, 404);
    return c.json({ eveVersion: await resolveProjectEveVersion(store, projectId) });
  });

  app.get("/projects/:projectId/source/files", async (c) => {
    return c.json({ files: await store.listSourceFiles(c.req.param("projectId")) });
  });

  app.get("/projects/:projectId/source/file", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing source file path" }, 400);
    }

    return c.json({ file: await store.getSourceFile(c.req.param("projectId"), filePath) });
  });

  app.get("/projects/:projectId/sessions", async (c) => {
    const parsed = sessionListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid Session filters", issues: parsed.error.issues }, 400);
    const page = await store.listSessionsPage(c.req.param("projectId"), parsed.data);
    return c.json({ sessions: page.items, nextCursor: page.nextCursor });
  });

  app.get("/sessions/:sessionId/events", async (c) => {
    return c.json({ events: await store.listSessionEvents(c.req.param("sessionId")) });
  });

  app.get("/sessions/:sessionId", async (c) => {
    const session = await store.getSession(c.req.param("sessionId"));
    return session ? c.json({ session }) : c.json({ error: "Session not found" }, 404);
  });

  app.get("/sessions/:sessionId/usage", async (c) => {
    return c.json({ usage: await store.listModelUsageEvents(c.req.param("sessionId")) });
  });

  app.get("/sessions/:sessionId/nodes", async (c) => {
    return c.json({ nodes: await store.listSessionNodes(c.req.param("sessionId")) });
  });

  app.get("/projects/:projectId/logs", async (c) => {
    const type = c.req.query("type") as LogRecord["type"] | undefined;
    return c.json({ logs: await store.listLogs(c.req.param("projectId"), type) });
  });

  return app;
}

function publicInvitation(invitation: TeamInvitation) {
  return invitation;
}

function getSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  return withGetSetCookie.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
}

function authErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "Authentication request failed";
  if (message === "Admin access required") return c.json({ error: message }, 403);
  if (message === "Invalid email or password") return c.json({ error: message }, 401);
  if (message.includes("last admin") || message.includes("already a team member") || message.includes("no longer pending")) {
    return c.json({ error: message }, 409);
  }
  if (message.includes("not found")) return c.json({ error: message }, 404);
  return c.json({ error: message }, 400);
}

async function invalidateGateway(options: AppOptions, hostnames: string[]): Promise<void> {
  if (options.invalidateGatewayRoutes) return options.invalidateGatewayRoutes(hostnames);
  const gatewayUrl = process.env.EVELAND_GATEWAY_INTERNAL_URL;
  const token = process.env.EVELAND_GATEWAY_SERVICE_TOKEN;
  if (!gatewayUrl || !token) return;
  for (const hostname of hostnames) {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/internal/cache/invalidate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ hostname }),
    });
    if (!response.ok) throw new Error(`Gateway cache invalidation failed with ${response.status}.`);
  }
}

function playgroundSessionIdFromPath(pathname: string): string | null {
  const match = /^\/eve\/v1\/session\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function readLimitedPlaygroundBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Playground request body is too large.");
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Playground request body is too large.").catch(() => undefined);
        throw new Error("Playground request body is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parsePlaygroundBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error("Playground turn must be valid JSON.");
  }
}

async function parsePlaygroundResponse(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  return parseEveJsonObject(await response.text());
}

async function resolveProjectEveVersion(store: Store, projectId: string, deploymentId?: string): Promise<EveVersionInfo> {
  const deployment = deploymentId
    ? await store.getDeployment(deploymentId)
    : await store.getCurrentDeployment(projectId);
  if (deployment) {
    return await store.getDeploymentEveVersion(deployment.id) ?? createEveVersionInfo(null, null);
  }

  const revision = await store.getCurrentSourceRevision(projectId);
  let version = revision ? getEveString(revision.summary, "eveVersion") : null;

  if (!version && revision) {
    const packageJson = await store.getSourceFile(projectId, "package.json");
    if (packageJson) version = readDeclaredEveVersion([{ path: packageJson.path, content: packageJson.content }]);
  }

  return createEveVersionInfo(version, revision?.id ?? null);
}

function monitorPlaygroundStream(
  body: ReadableStream<Uint8Array>,
  store: Store,
  platformSessionId: string,
  eveSessionId: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentStatus: SessionStatus = "running";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          const tail = buffer.trim();
          if (tail) currentStatus = await projectPlaygroundStreamLine(tail, currentStatus, store, platformSessionId, eveSessionId);
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) currentStatus = await projectPlaygroundStreamLine(line, currentStatus, store, platformSessionId, eveSessionId);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

async function projectPlaygroundStreamLine(
  line: string,
  currentStatus: SessionStatus,
  store: Store,
  platformSessionId: string,
  eveSessionId: string,
): Promise<SessionStatus> {
  const event = parseEveJsonObject(line);
  const type = getEveString(event, "type");
  let nextStatus: SessionStatus | null = null;
  if (type === "session.started" || type === "turn.started") nextStatus = "running";
  else if (type === "input.requested") nextStatus = "waiting_approval";
  else if (type === "session.waiting") nextStatus = currentStatus === "waiting_approval" ? "waiting_approval" : "waiting";
  else if (type === "session.completed") nextStatus = "completed";
  else if (type === "session.failed") nextStatus = "failed";
  if (!nextStatus) return currentStatus;
  await store.completeSession(platformSessionId, { status: nextStatus, eveSessionId }).catch(() => null);
  return nextStatus;
}

function isMultipartRequest(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().includes("multipart/form-data");
}

function currentUserId(c: Context<{ Variables: { principal: AuthPrincipal } }>): string {
  return c.get("principal")?.userId ?? "user_local_admin";
}

// The sync body is optional; only `{ "deploy": true }` opts into an automatic
// deploy of the freshly synced source, otherwise the sync just refreshes it.
async function readSyncDeployFlag(c: Context): Promise<boolean> {
  try {
    const body = (await c.req.json()) as unknown;
    return typeof body === "object" && body !== null && (body as { deploy?: unknown }).deploy === true;
  } catch {
    return false;
  }
}

async function createZipProjectFromUpload(c: Context, store: Store, dataDir: string) {
  const form = await c.req.formData();
  const name = form.get("name");
  const archive = form.get("archive");
  const deployAfterImport = form.get("deployAfterImport") === "true";

  const parsedName = projectNameSchema.safeParse(name);
  if (!parsedName.success) {
    return c.json({
      error: "Invalid project input",
      issues: parsedName.error.issues.map((issue) => ({ ...issue, path: ["name", ...issue.path] })),
    }, 400);
  }

  if (!(archive instanceof File) || archive.size === 0) {
    return c.json({ error: "Invalid zip upload", issues: [{ path: ["archive"], message: "Source archive is required" }] }, 400);
  }

  if (!(await store.isProjectSlugAvailable(parsedName.data))) {
    return c.json({ error: "Project name is already in use." }, 409);
  }

  const { sourcePath, uploadDir } = await extractZipUpload(archive, dataDir);
  try {
    const project = await store.createProject({
      name: parsedName.data,
      importKind: "zip",
      sourcePath,
      requireExactSlug: true,
      deployAfterImport,
    });
    return c.json({ project }, 201);
  } catch (error) {
    await rm(uploadDir, { recursive: true, force: true });
    if (error instanceof ProjectSlugConflictError) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
}

async function extractZipUpload(archive: File, dataDir: string): Promise<{ sourcePath: string; uploadDir: string }> {
  const uploadsDir = path.resolve(dataDir, "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const uploadDir = await mkdtemp(path.join(uploadsDir, "zip-"));
  const archivePath = path.join(uploadDir, "source.zip");
  const extractDir = path.join(uploadDir, "source");
  await mkdir(extractDir, { recursive: true });
  await writeFile(archivePath, Buffer.from(await archive.arrayBuffer()));

  const entries = await listZipEntries(archivePath);
  for (const entry of entries) {
    assertSafeZipEntry(entry);
  }

  await execFileAsync("unzip", ["-q", archivePath, "-d", extractDir]);
  await rm(archivePath, { force: true });
  return { sourcePath: await resolveExtractedSourceRoot(extractDir), uploadDir };
}

async function listZipEntries(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("unzip", ["-Z1", archivePath]);
  return stdout.split(/\r?\n/).filter(Boolean);
}

function assertSafeZipEntry(entry: string): void {
  const normalizedEntry = entry.trim().replace(/\/+$/, "");
  if (normalizedEntry.length === 0) {
    return;
  }

  assertSafeArchivePath(normalizedEntry);
}

async function resolveExtractedSourceRoot(extractDir: string): Promise<string> {
  const entries = await readdir(extractDir, { withFileTypes: true });
  const projectEntries = entries.filter((entry) => entry.name !== "__MACOSX" && entry.name !== ".DS_Store");

  if (projectEntries.length === 1 && projectEntries[0]?.isDirectory()) {
    return path.join(extractDir, projectEntries[0].name);
  }

  return extractDir;
}

function safeSecretEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function isServiceRequest(authorization: string | undefined, token: string | undefined): boolean {
  return Boolean(token && authorization && safeSecretEqual(`Bearer ${token}`, authorization));
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

async function waitForRuntimeActivation(
  store: Store,
  claim: ActivationLeaseClaim,
  input: { signal: AbortSignal; timeoutMs: number },
): Promise<RuntimeInstance> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.signal.aborted) throw new Error("Runtime activation aborted.");
    const current = await store.getRuntimeInstance(claim.runtimeInstance.id);
    if (!current) throw new Error("RuntimeInstance disappeared during activation.");
    if (current.status === "ready") return current;
    if (current.status === "failed" || current.status === "stopped") {
      throw new Error(current.lastError ?? `Runtime activation ended in ${current.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Runtime activation timed out after ${input.timeoutMs}ms.`);
}
