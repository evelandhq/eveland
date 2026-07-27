import {
  inferProjectSlugFromGitUrl,
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_PATTERN,
} from "@eveland/core/ids";
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
  key: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]*$/,
      "Use uppercase letters, numbers, and underscores, starting with a letter.",
    ),
  kind: z.enum(["variable", "secret"]).default("secret"),
  value: z.string().min(1).max(65_536),
});

export const createProjectFromPreflightSchema = z
  .object({
    name: projectNameSchema,
    preflightId: z.string().regex(/^pre_[0-9A-Za-z]+$/),
    deployAfterImport: z.boolean().optional(),
    environmentVariables: z
      .array(environmentVariableSchema)
      .max(50)
      .default([]),
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

export const secretSchema = environmentVariableSchema;

export const updateSecretSchema = environmentVariableSchema.extend({
  value: z.string().min(1).max(65_536).optional(),
});

export const sharedAgentEnvironmentEntrySchema = z.object({
  key: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]*$/,
      "Use uppercase letters, numbers, and underscores, starting with a letter.",
    ),
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

export const playgroundMessageSchema = z.object({
  message: z.string().min(1),
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
    .refine(
      (value) => value.startsWith("?"),
      "OIDC callback search must start with ?.",
    ),
});

export const invitationSchema = z.object({
  email: z.email(),
});

export const memberRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1),
  password: z.string().min(12),
});

export const profileImageSchema = z.string().superRefine((value, context) => {
  const match =
    /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
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
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(128),
});

export const createIdentityProviderSchema = z.discriminatedUnion("type", [
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
    tokenEndpointAuthMethod: z.enum([
      "client_secret_basic",
      "client_secret_post",
      "none",
    ]),
    externalRealmResolution: z.enum([
      "connection",
      "id_token_claim",
      "userinfo_claim",
      "provider_api",
    ]),
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
  tokenEndpointAuthMethod: z
    .enum(["client_secret_basic", "client_secret_post", "none"])
    .optional(),
  externalRealmResolution: z
    .enum(["connection", "id_token_claim", "userinfo_claim", "provider_api"])
    .optional(),
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
  origin: z
    .url()
    .refine((value) => {
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
    status: z.enum(["succeeded", "failed"]),
    error: z.string().min(1).max(2000).optional(),
  }),
]);

export const runtimeActivationSchema = z.object({
  deploymentId: z.string().min(1),
  kind: z.enum(["public_request", "stream", "turn"]),
  ownerId: z.string().min(1).max(256),
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
    .enum([
      "playground",
      "api",
      "cron",
      "manual",
      "webhook",
      "channel",
      "direct_http",
    ])
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
  if (
    value.targets.reduce((sum, target) => sum + target.weight, 0) !== 10_000
  ) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "Route target weights must total 10,000.",
    });
  }
  if (
    new Set(value.targets.map((target) => target.deploymentId)).size !==
    value.targets.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "Route target deployments must be unique.",
    });
  }
}
