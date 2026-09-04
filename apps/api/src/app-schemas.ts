import {
  ENVIRONMENT_ENTRY_KEY_MESSAGE,
  ENVIRONMENT_ENTRY_KEY_PATTERN,
} from "@evelandhq/core/environment-entries";
import {
  inferProjectSlugFromGitUrl,
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_PATTERN,
} from "@evelandhq/core/ids";
import { z } from "zod";

export const projectNameSchema = z
  .string()
  .min(1)
  .max(PROJECT_SLUG_MAX_LENGTH)
  .regex(
    PROJECT_SLUG_PATTERN,
    "Use lowercase letters, numbers, and hyphens, with no leading or trailing hyphen.",
  );

export const updateProjectMetadataSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z
    .string()
    .trim()
    .max(240)
    .transform((value) => value || null),
});

export const gitRepositoryUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => inferProjectSlugFromGitUrl(value) !== null,
    "Enter a Git repository URL with a repository name.",
  );

export const createProjectSchema = z.discriminatedUnion("importKind", [
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

export const environmentVariableSchema = z.object({
  key: z.string().regex(ENVIRONMENT_ENTRY_KEY_PATTERN, ENVIRONMENT_ENTRY_KEY_MESSAGE),
  kind: z.enum(["variable", "secret"]).default("secret"),
  value: z.string().min(1).max(65_536),
});

export const createProjectFromPreflightSchema = z
  .object({
    name: projectNameSchema,
    preflightId: z.string().regex(/^pre_[0-9A-Za-z]+$/),
    deployAfterImport: z.boolean().optional(),
    environmentVariables: z.array(environmentVariableSchema).max(50).default([]),
  })
  .superRefine((input, context) => {
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

export const createGitCredentialSchema = z.object({
  host: z.string().min(1).max(255),
  gitlabPat: z.string().min(1).max(1024),
});

export const createGitSourcePreflightSchema = z.object({
  kind: z.literal("git"),
  gitUrl: gitRepositoryUrlSchema,
  gitlabPat: z.string().min(1).max(1024).optional(),
});

export const syncSourceSchema = z
  .object({
    deploy: z.boolean().default(false),
    promote: z.boolean().default(false),
  })
  .refine((input) => !input.promote || input.deploy, {
    message: "A synced source must be deployed before it can be promoted.",
    path: ["promote"],
  });

export const buildDeploySchema = z.object({
  promote: z.boolean().default(false),
});

export const secretSchema = environmentVariableSchema;

export const batchSecretSchema = z
  .object({
    entries: z.array(environmentVariableSchema).min(1).max(50),
  })
  .superRefine((input, context) => {
    const keys = new Set<string>();
    input.entries.forEach((entry, index) => {
      if (keys.has(entry.key)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "key"],
          message: "Project environment names must be unique.",
        });
      }
      keys.add(entry.key);
    });
  });

export const updateSecretSchema = environmentVariableSchema.extend({
  value: z.string().min(1).max(65_536).optional(),
});

export const sharedAgentEnvironmentEntrySchema = z.object({
  key: z.string().regex(ENVIRONMENT_ENTRY_KEY_PATTERN, ENVIRONMENT_ENTRY_KEY_MESSAGE),
  kind: z.enum(["variable", "secret"]),
  value: z.string().min(1).max(65_536).optional(),
});

export const sharedAgentEnvironmentSchema = z
  .object({
    entries: z.array(sharedAgentEnvironmentEntrySchema).max(50),
  })
  .superRefine((input, context) => {
    const keys = new Set<string>();
    input.entries.forEach((entry, index) => {
      if (keys.has(entry.key)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "key"],
          message: "Shared Agent environment keys must be unique.",
        });
      }
      keys.add(entry.key);
    });
  });

export const updateAgentConnectionSchema = z.object({
  expectedSecurityRevision: z.number().int().positive(),
  method: z.string().min(1),
  config: z.unknown(),
});

export const agentAuthCallbackSchema = z.object({
  search: z
    .string()
    .min(1)
    .max(8_192)
    .refine((value) => value.startsWith("?"), "OIDC callback search must start with ?."),
});

export const invitationSchema = z.object({
  email: z.email(),
});

export const memberRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

export const previewInvitationSchema = z.object({
  token: z.string().min(1),
});

// Name and password policy depend on whether the invited email already has an
// account, which only the auth runtime can see -- it enforces both (name plus
// the 12-character minimum for new accounts; the stored credential for
// existing ones).
export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  password: z.string().min(1),
});

export const passwordResetPreviewSchema = z.object({
  token: z.string().min(1),
});

export const passwordResetCompleteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(12).max(128),
});

export const profileImageSchema = z.string().superRefine((value, context) => {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match?.[1]) {
    context.addIssue({
      code: "custom",
      message: "Avatar must be a PNG, JPEG, or WebP image.",
    });
    return;
  }
  if (Buffer.from(match[1], "base64").byteLength > 512 * 1024) {
    context.addIssue({
      code: "custom",
      message: "Avatar must not exceed 512 KB.",
    });
  }
});

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  image: profileImageSchema.nullable(),
  displayTimezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    }, "Display timezone must be a valid IANA timezone.")
    .optional(),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(128),
});

export const createIdentityProviderSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("open"),
    displayName: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("internal"),
    displayName: z.string().trim().min(1).max(100),
    internalRealmKey: z.string().trim().min(1).max(256),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("oidc"),
    displayName: z.string().trim().min(1).max(100),
    issuer: z.url(),
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().min(1).max(8_192).optional(),
    scopes: z.array(z.string().trim().min(1)).min(1),
    authorizationParameters: z.record(z.string(), z.string()).default({}),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post", "none"]),
    externalRealmResolution: z.enum(["connection", "id_token_claim", "userinfo_claim"]),
    externalRealmClaim: z.string().trim().min(1).optional(),
    enabled: z.boolean(),
  }),
]);

export const updateIdentityProviderSchema = z.object({
  expectedSecurityRevision: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(100),
  internalRealmKey: z.string().trim().min(1).max(256).optional(),
  issuer: z.url().optional(),
  clientId: z.string().trim().min(1).max(512).optional(),
  clientSecret: z.string().min(1).max(8_192).nullable().optional(),
  scopes: z.array(z.string().trim().min(1)).min(1).optional(),
  authorizationParameters: z.record(z.string(), z.string()).optional(),
  tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post", "none"]).optional(),
  externalRealmResolution: z.enum(["connection", "id_token_claim", "userinfo_claim"]).optional(),
  externalRealmClaim: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean(),
});

export const createIdentityRealmSchema = z.object({
  providerConnectionId: z.string().min(1),
  externalRealmId: z.string().trim().min(1).max(512),
  externalRealmKind: z.enum([
    "internal",
    "account",
    "corp",
    "workspace",
    "enterprise",
    "tenant",
    "organization",
  ]),
  displayName: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
});

export const updateIdentityRealmSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
});

export const upsertIdentityReturnTargetSchema = z.object({
  origin: z.url().refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }, "Return target must be an exact HTTP(S) origin."),
  enabled: z.boolean(),
});

export const callerTokenRequestSchema = z.object({
  projectId: z.string().min(1),
});

export const openCallerTokenRequestSchema = z.object({
  projectId: z.string().min(1),
});

export const identityAppTokenRequestSchema = z.object({
  target: z.string().trim().min(1),
});

export const schedulerDispatchSchema = z.discriminatedUnion("phase", [
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
    // `dispatch_unknown` reports an ambiguous outcome (e.g. a command-hook
    // readiness timeout after the durable workflow may have committed): the
    // scheduled Session may still start, so the run must not read as failed.
    status: z.enum(["succeeded", "failed", "dispatch_unknown"]),
    error: z.string().min(1).max(2000).optional(),
  }),
]);

export const workflowDispatcherHeartbeatSchema = z
  .object({
    instanceId: z.string().min(1).max(128),
    generation: z.string().min(1).max(256),
    state: z.enum(["recovering", "ready", "draining", "failed", "stopped"]),
    ownershipAcquired: z.boolean(),
    bootRecoveryCompleted: z.boolean(),
    reenqueuedRuns: z.number().int().nonnegative().nullable(),
    worldDatabaseIdentity: z.string().max(512),
    schemaGeneration: z.string().max(256).nullable(),
    protocolMin: z.number().int().positive(),
    protocolMax: z.number().int().positive(),
    startedAt: z.string().datetime(),
    readyAt: z.string().datetime().nullable(),
  })
  // The identity is the database's own cluster fingerprint
  // (`cluster:<pg system_identifier>/<database>`), or "unknown" while the
  // dispatcher cannot read it — never a connection URL: a registration is
  // diagnostics surface and must not be able to carry credentials, and
  // readiness compares cluster identities, so nothing else may register.
  .refine(
    (value) =>
      value.worldDatabaseIdentity === "unknown" ||
      (value.worldDatabaseIdentity.startsWith("cluster:") &&
        !/:\/\/|@/.test(value.worldDatabaseIdentity)),
    {
      message:
        'worldDatabaseIdentity must be a cluster:<system_identifier>/<database> identity or "unknown", never a URL',
    },
  );

/**
 * The dispatcher's boot-recovery preflight: the distinct Deployments its
 * candidate runs are bound to. Bounded generously — one instance's whole
 * backlog spanned single-digit Deployments (#425) — but bounded, because an
 * unbounded id list is an unbounded number of store lookups.
 */
export const workflowRecoveryPreflightSchema = z.object({
  deploymentIds: z.array(z.string().min(1).max(128)).max(2_000),
});

export const runtimeActivationSchema = z.object({
  deploymentId: z.string().min(1),
  // Narrower than ActivationLeaseKind on purpose: schedule_run leases are
  // taken in-process by the worker, never over this API.
  kind: z.enum(["public_request", "stream", "turn", "workflow_step"]),
  ownerId: z.string().min(1).max(256),
});

// Empty body = acknowledge every unacknowledged failed run in the project.
export const acknowledgeScheduleRunsSchema = z.object({
  runIds: z.array(z.string().min(1)).min(1).max(200).optional(),
});

export const scheduleRunListQuerySchema = z.object({
  scheduleId: z.string().min(1).optional(),
  trigger: z.enum(["cron", "manual"]).optional(),
  status: z
    .enum([
      "queued",
      "activating",
      "dispatching",
      "running",
      "succeeded",
      "failed",
      "dispatch_unknown",
      "skipped",
    ])
    .optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const sessionListQuerySchema = z.object({
  trigger: z
    .enum(["playground", "api", "cron", "manual", "webhook", "channel", "direct_http"])
    .optional(),
  scheduleId: z.string().min(1).optional(),
  scheduleRunId: z.string().min(1).optional(),
  unlinkedOnly: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const deploymentListQuerySchema = z.object({
  // A Project accumulates archived Deployments forever, and they are the ones
  // nobody can act on -- so the overview leaves them out until asked.
  archived: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const usageAnalyticsQuerySchema = z.object({
  range: z.enum(["24h", "7d", "30d"]).default("7d"),
  modelId: z.string().min(1).max(512).optional(),
});

export const targetsArraySchema = z
  .array(
    z.object({
      deploymentId: z.string().min(1),
      weight: z.number().int().min(0).max(10_000),
      variantName: z.string().min(1).nullable(),
    }),
  )
  .min(1)
  .max(2);

export const routeTargetsSchema = z
  .object({ targets: targetsArraySchema })
  .superRefine(validateTargetsPayload);
export const aliasSchema = z
  .object({
    alias: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    targets: targetsArraySchema,
  })
  .superRefine(validateTargetsPayload);

function validateTargetsPayload(
  value: { targets: Array<{ deploymentId: string; weight: number }> },
  context: z.RefinementCtx,
): void {
  if (value.targets.reduce((sum, target) => sum + target.weight, 0) !== 10_000) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "Route target weights must total 10,000.",
    });
  }
  if (new Set(value.targets.map((target) => target.deploymentId)).size !== value.targets.length) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "Route target deployments must be unique.",
    });
  }
}
