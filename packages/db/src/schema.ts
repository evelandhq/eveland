import { sql } from "drizzle-orm";
import { bigint, boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name").notNull(),
  image: text("image"),
  role: text("role").default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMemberships = pgTable(
  "team_memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("team_memberships_role_check", sql`${table.role} in ('admin', 'member')`),
    index("team_memberships_user_idx").on(table.userId),
    index("team_memberships_team_idx").on(table.organizationId),
    uniqueIndex("team_memberships_team_user_idx").on(table.organizationId, table.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("invited_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("invitations_role_check", sql`${table.role} in ('admin', 'member')`),
    check("invitations_status_check", sql`${table.status} in ('pending', 'accepted', 'rejected', 'canceled')`),
    index("invitations_team_status_idx").on(table.organizationId, table.status),
    index("invitations_email_idx").on(table.email),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_team_id"),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_sessions_user_idx").on(table.userId), index("auth_sessions_expires_idx").on(table.expiresAt)],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("auth_accounts_user_idx").on(table.userId),
    uniqueIndex("auth_accounts_provider_account_idx").on(table.providerId, table.accountId),
  ],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_verifications_identifier_idx").on(table.identifier)],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    teamId: text("team_id").notNull().default("team_local").references(() => teams.id),
    ownerId: text("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    importKind: text("import_kind").notNull(),
    gitUrl: text("git_url"),
    status: text("status").notNull(),
    deploymentStatus: text("deployment_status").notNull(),
    deletionStatus: text("deletion_status"),
    deletionError: text("deletion_error"),
    sourceRevisionId: text("source_revision_id"),
    releaseId: text("release_id"),
    deploymentId: text("deployment_id"),
    latestSessionStatus: text("latest_session_status"),
    nextScheduleAt: timestamp("next_schedule_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "projects_slug_check",
      sql`char_length(${table.slug}) <= 53 and ${table.slug} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`,
    ),
    check("projects_deletion_status_check", sql`${table.deletionStatus} is null or ${table.deletionStatus} in ('deleting', 'failed')`),
  ],
);

export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    key: text("key").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("secrets_project_key_idx").on(table.projectId, table.key)],
);

export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  type: text("type").notNull(),
  status: text("status").notNull(),
  payload: jsonb("payload").notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  cron: text("cron"),
  timezone: text("timezone"),
  enabled: boolean("enabled").notNull().default(true),
  executable: boolean("executable").notNull().default(false),
  sourcePath: text("source_path").notNull(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
});

export const sourceRevisions = pgTable("source_revisions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  kind: text("kind").notNull(),
  commitSha: text("commit_sha"),
  sourcePath: text("source_path").notNull(),
  summary: jsonb("summary").notNull().default({}),
  envVars: jsonb("env_vars").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const releases = pgTable("releases", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  sourceRevisionId: text("source_revision_id").notNull().references(() => sourceRevisions.id),
  imageTag: text("image_tag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    projectId: text("project_id").notNull().references(() => projects.id),
    releaseId: text("release_id").notNull().references(() => releases.id),
    containerName: text("container_name").notNull(),
    internalPort: integer("internal_port").notNull(),
    hostPort: integer("host_port").notNull(),
    status: text("status").notNull(),
    // No default: every caller must state which runtime adapter created the deployment.
    // The migration backfills existing rows with 'docker' then drops the column default.
    runtimeKind: text("runtime_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("deployments_project_key_idx").on(table.projectId, table.deploymentKey),
    check("deployments_key_check", sql`${table.deploymentKey} ~ '^[a-z0-9]{8}$'`),
  ],
);

export const agentRoutes = pgTable(
  "agent_routes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    hostname: text("hostname").notNull(),
    kind: text("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    policyRevision: integer("policy_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_routes_hostname_idx").on(table.hostname),
    check("agent_routes_kind_check", sql`${table.kind} in ('project', 'deployment', 'alias')`),
  ],
);

export const routeTargets = pgTable(
  "route_targets",
  {
    routeId: text("route_id").notNull().references(() => agentRoutes.id),
    deploymentId: text("deployment_id").notNull().references(() => deployments.id),
    weight: integer("weight").notNull(),
    variantName: text("variant_name"),
  },
  (table) => [
    uniqueIndex("route_targets_route_deployment_idx").on(table.routeId, table.deploymentId),
    check("route_targets_weight_check", sql`${table.weight} between 0 and 10000`),
  ],
);

export const sessionBindings = pgTable(
  "session_bindings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    eveSessionId: text("eve_session_id").notNull(),
    routeId: text("route_id").notNull().references(() => agentRoutes.id),
    deploymentId: text("deployment_id").notNull().references(() => deployments.id),
    trigger: text("trigger").notNull(),
    variantName: text("variant_name"),
    experimentId: text("experiment_id"),
    requestId: text("request_id").notNull(),
    remoteIp: text("remote_ip"),
    affinityFingerprint: text("affinity_fingerprint"),
    affinitySource: text("affinity_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("session_bindings_project_eve_idx").on(table.projectId, table.eveSessionId)],
);

export const sourceFiles = pgTable(
  "source_files",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id").notNull().references(() => sourceRevisions.id),
    path: text("path").notNull(),
    content: text("content").notNull(),
    size: integer("size").notNull(),
  },
  (table) => [uniqueIndex("source_files_revision_path_idx").on(table.revisionId, table.path)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  deploymentId: text("deployment_id"),
  eveSessionId: text("eve_session_id"),
  continuationToken: text("continuation_token"),
  rootNodeId: text("root_node_id"),
  routeId: text("route_id").references(() => agentRoutes.id),
  experimentId: text("experiment_id"),
  variantName: text("variant_name"),
  trigger: text("trigger").notNull(),
  scheduleId: text("schedule_id"),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
  cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
  costUsd: doublePrecision("cost_usd"),
  usageReportedSteps: integer("usage_reported_steps").notNull().default(0),
  usageMissingSteps: integer("usage_missing_steps").notNull().default(0),
});

export const sessionNodes = pgTable(
  "session_nodes",
  {
    id: text("id").primaryKey(),
    rootSessionId: text("root_session_id").notNull().references(() => sessions.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    eveSessionId: text("eve_session_id").notNull(),
    parentNodeId: text("parent_node_id"),
    parentEveSessionId: text("parent_eve_session_id"),
    startedDeploymentId: text("started_deployment_id").notNull().references(() => deployments.id),
    lastObservedDeploymentId: text("last_observed_deployment_id").notNull().references(() => deployments.id),
    agentId: text("agent_id"),
    agentName: text("agent_name"),
    nodeId: text("node_id"),
    channelKind: text("channel_kind"),
    modelId: text("model_id"),
    eveVersion: text("eve_version"),
    remoteUrl: text("remote_url"),
    resolutionStatus: text("resolution_status").notNull().default("observed"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("session_nodes_project_eve_idx").on(table.projectId, table.eveSessionId)],
);

export const modelUsageEvents = pgTable(
  "model_usage_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id),
    sessionNodeId: text("session_node_id").references(() => sessionNodes.id),
    eveSessionId: text("eve_session_id").notNull(),
    agentId: text("agent_id"),
    agentName: text("agent_name"),
    turnId: text("turn_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    finishReason: text("finish_reason"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    costUsd: doublePrecision("cost_usd"),
    usageReported: boolean("usage_reported").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("model_usage_session_eve_turn_step_idx").on(table.sessionId, table.eveSessionId, table.turnId, table.stepIndex),
    uniqueIndex("model_usage_node_turn_step_idx").on(table.sessionNodeId, table.turnId, table.stepIndex),
  ],
);

export const sessionEvents = pgTable(
  "session_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id),
    sessionNodeId: text("session_node_id").references(() => sessionNodes.id),
    observerEventId: text("observer_event_id"),
    eventFingerprint: text("event_fingerprint"),
    observedDeploymentId: text("observed_deployment_id").references(() => deployments.id),
    sourceSequence: integer("source_sequence"),
    index: integer("index").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    eventAt: timestamp("event_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("session_events_node_observer_idx").on(table.sessionNodeId, table.observerEventId),
    uniqueIndex("session_events_node_fingerprint_idx").on(table.sessionNodeId, table.eventFingerprint),
  ],
);

export const logs = pgTable("logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  deploymentId: text("deployment_id"),
  type: text("type").notNull(),
  line: text("line").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
