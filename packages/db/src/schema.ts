import type { PgInstanceConnectionSample } from "@evelandhq/core/instance-health";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name").notNull(),
  image: text("image"),
  displayTimezone: text("display_timezone"),
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
    organizationId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    organizationId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("invitations_role_check", sql`${table.role} in ('admin', 'member')`),
    check(
      "invitations_status_check",
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'canceled')`,
    ),
    index("invitations_team_status_idx").on(table.organizationId, table.status),
    index("invitations_email_idx").on(table.email),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_team_id"),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("auth_sessions_user_idx").on(table.userId),
    index("auth_sessions_expires_idx").on(table.expiresAt),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    teamId: text("team_id")
      .notNull()
      .default("team_local")
      .references(() => teams.id),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    description: text("description"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "projects_slug_check",
      sql`char_length(${table.slug}) <= 53 and ${table.slug} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`,
    ),
    check(
      "projects_deletion_status_check",
      sql`${table.deletionStatus} is null or ${table.deletionStatus} in ('deleting', 'failed')`,
    ),
  ],
);

export const gitCredentials = pgTable(
  "git_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("git_credentials_user_host_idx").on(table.userId, table.host),
    index("git_credentials_user_idx").on(table.userId),
  ],
);

export const sourcePreflights = pgTable(
  "source_preflights",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    gitUrl: text("git_url"),
    sourcePath: text("source_path"),
    commitSha: text("commit_sha"),
    status: text("status").notNull().default("queued"),
    summary: jsonb("summary"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    credentialHost: text("credential_host"),
    encryptedToken: text("encrypted_token"),
    persistCredential: boolean("persist_credential").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("source_preflights_kind_check", sql`${table.kind} in ('git', 'zip')`),
    check(
      "source_preflights_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'consumed')`,
    ),
    index("source_preflights_user_idx").on(table.userId),
    index("source_preflights_queue_idx").on(table.status, table.createdAt),
    index("source_preflights_expiry_idx").on(table.expiresAt),
  ],
);

export const agentConnections = pgTable(
  "agent_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").notNull(),
    method: text("method").notNull(),
    configEncrypted: text("config_encrypted").notNull(),
    securityRevision: integer("security_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_connections_project_idx").on(table.projectId),
    check("agent_connections_target_kind_check", sql`${table.targetKind} = 'managed-project'`),
    check("agent_connections_security_revision_check", sql`${table.securityRevision} > 0`),
  ],
);

export const agentAuthCredentials = pgTable(
  "agent_auth_credentials",
  {
    agentConnectionId: text("agent_connection_id")
      .notNull()
      .references(() => agentConnections.id, { onDelete: "cascade" }),
    securityRevision: integer("security_revision").notNull(),
    authMethod: text("auth_method").notNull(),
    credentialScope: text("credential_scope").notNull(),
    scopeSubject: text("scope_subject").notNull(),
    credentialKey: text("credential_key").notNull().default(""),
    payloadEncrypted: text("payload_encrypted").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    rotationSeq: integer("rotation_seq").notNull().default(0),
    refreshOwner: text("refresh_owner"),
    refreshLeaseId: text("refresh_lease_id"),
    refreshLeaseUntil: timestamp("refresh_lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_auth_credentials_scope_idx").on(
      table.agentConnectionId,
      table.securityRevision,
      table.authMethod,
      table.credentialScope,
      table.scopeSubject,
      table.credentialKey,
    ),
    check("agent_auth_credentials_security_revision_check", sql`${table.securityRevision} > 0`),
    check("agent_auth_credentials_rotation_seq_check", sql`${table.rotationSeq} >= 0`),
    check(
      "agent_auth_credentials_scope_check",
      sql`(${table.credentialScope} = 'connection' and ${table.scopeSubject} = '') or (${table.credentialScope} = 'principal' and ${table.scopeSubject} <> '')`,
    ),
  ],
);

export const agentAuthTransactions = pgTable(
  "agent_auth_transactions",
  {
    agentConnectionId: text("agent_connection_id")
      .notNull()
      .references(() => agentConnections.id, { onDelete: "cascade" }),
    stateHash: text("state_hash").primaryKey(),
    payloadEncrypted: text("payload_encrypted").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agent_auth_transactions_expires_idx").on(table.expiresAt)],
);

export const identityProviderConnections = pgTable(
  "identity_provider_connections",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    displayName: text("display_name").notNull(),
    internalRealmKey: text("internal_realm_key"),
    issuer: text("issuer"),
    clientId: text("client_id"),
    clientSecretEncrypted: text("client_secret_encrypted"),
    scopes: jsonb("scopes").notNull().default([]),
    authorizationParameters: jsonb("authorization_parameters").notNull().default({}),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    externalRealmResolution: text("external_realm_resolution").notNull(),
    externalRealmClaim: text("external_realm_claim"),
    enabled: boolean("enabled").notNull().default(false),
    securityRevision: integer("security_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The Identity Provider is platform-wide and exclusive: open, internal, or
    // OIDC, never two at once. The index expression is the constant `true`
    // rather than a column so the uniqueness stays global no matter how the
    // predicate is later widened -- indexing a column that the predicate
    // happens to pin to one value only reads as global by accident.
    uniqueIndex("identity_provider_connections_one_enabled_idx")
      .on(sql`(true)`)
      .where(sql`${table.enabled} = true`),
    check(
      "identity_provider_connections_type_check",
      sql`${table.type} in ('internal', 'oidc', 'open')`,
    ),
    check("identity_provider_connections_revision_check", sql`${table.securityRevision} > 0`),
    check(
      "identity_provider_connections_shape_check",
      sql`(
        ${table.type} = 'open'
        and ${table.internalRealmKey} is null
        and ${table.issuer} is null
        and ${table.clientId} is null
      ) or (
        ${table.type} = 'internal'
        and ${table.internalRealmKey} is not null
        and ${table.issuer} is null
        and ${table.clientId} is null
      ) or (
        ${table.type} = 'oidc'
        and ${table.internalRealmKey} is null
        and ${table.issuer} is not null
        and ${table.clientId} is not null
        and ${table.tokenEndpointAuthMethod} in ('client_secret_basic', 'client_secret_post', 'none')
      )`,
    ),
  ],
);

export const identityRealms = pgTable(
  "identity_realms",
  {
    id: text("id").primaryKey(),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => identityProviderConnections.id, { onDelete: "cascade" }),
    externalRealmId: text("external_realm_id").notNull(),
    externalRealmKind: text("external_realm_kind").notNull(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_realms_provider_external_idx").on(
      table.providerConnectionId,
      table.externalRealmId,
    ),
    index("identity_realms_provider_idx").on(table.providerConnectionId),
    check(
      "identity_realms_kind_check",
      sql`${table.externalRealmKind} in ('internal', 'account', 'corp', 'workspace', 'enterprise', 'tenant', 'organization')`,
    ),
  ],
);

export const identityPrincipals = pgTable(
  "identity_principals",
  {
    id: text("id").primaryKey(),
    identityRealmId: text("identity_realm_id")
      .notNull()
      .references(() => identityRealms.id, { onDelete: "cascade" }),
    externalSubject: text("external_subject").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    claims: jsonb("claims").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_principals_realm_subject_idx").on(
      table.identityRealmId,
      table.externalSubject,
    ),
    index("identity_principals_realm_idx").on(table.identityRealmId),
  ],
);

export const identitySessions = pgTable(
  "identity_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    identityPrincipalId: text("identity_principal_id")
      .notNull()
      .references(() => identityPrincipals.id, { onDelete: "cascade" }),
    activeIdentityRealmId: text("active_identity_realm_id")
      .notNull()
      .references(() => identityRealms.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("identity_sessions_token_idx").on(table.tokenHash),
    index("identity_sessions_principal_idx").on(table.identityPrincipalId),
    index("identity_sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const identityReturnTargets = pgTable("identity_return_targets", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  origin: text("origin").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const identityLoginTransactions = pgTable(
  "identity_login_transactions",
  {
    stateHash: text("state_hash").primaryKey(),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => identityProviderConnections.id, { onDelete: "cascade" }),
    providerSecurityRevision: integer("provider_security_revision").notNull(),
    returnTargetId: text("return_target_id")
      .notNull()
      .references(() => identityReturnTargets.id, { onDelete: "cascade" }),
    returnPath: text("return_path").notNull(),
    nonceHash: text("nonce_hash"),
    pkceVerifierEncrypted: text("pkce_verifier_encrypted"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("identity_login_transactions_expiry_idx").on(table.expiresAt),
    index("identity_login_transactions_provider_idx").on(table.providerConnectionId),
  ],
);

export const identityOidcCredentials = pgTable(
  "identity_oidc_credentials",
  {
    identityPrincipalId: text("identity_principal_id")
      .notNull()
      .references(() => identityPrincipals.id, { onDelete: "cascade" }),
    providerConnectionId: text("provider_connection_id")
      .notNull()
      .references(() => identityProviderConnections.id, { onDelete: "cascade" }),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    scope: text("scope").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    rotationSeq: integer("rotation_seq").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.identityPrincipalId, table.providerConnectionId] }),
    check("identity_oidc_credentials_rotation_check", sql`${table.rotationSeq} >= 0`),
  ],
);

export const identitySigningKeys = pgTable(
  "identity_signing_keys",
  {
    id: text("id").primaryKey(),
    algorithm: text("algorithm").notNull(),
    publicJwk: jsonb("public_jwk").notNull(),
    privateKeyEncrypted: text("private_key_encrypted").notNull(),
    status: text("status").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("identity_signing_keys_algorithm_check", sql`${table.algorithm} = 'ES256'`),
    check(
      "identity_signing_keys_status_check",
      sql`${table.status} in ('active', 'retiring', 'retired')`,
    ),
    uniqueIndex("identity_signing_keys_one_active_idx")
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    key: text("key").notNull(),
    kind: text("kind").notNull().default("secret"),
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("secrets_kind_check", sql`${table.kind} in ('variable', 'secret')`),
    uniqueIndex("secrets_project_key_idx").on(table.projectId, table.key),
  ],
);

export const sharedAgentEnvironment = pgTable(
  "shared_agent_environment",
  {
    key: text("key").primaryKey(),
    revision: integer("revision").notNull().default(1),
    entries: jsonb("entries").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("shared_agent_environment_key_check", sql`${table.key} = 'global'`),
    check("shared_agent_environment_revision_check", sql`${table.revision} > 0`),
  ],
);

export const observabilityPolicies = pgTable(
  "observability_policies",
  {
    teamId: text("team_id")
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    document: jsonb("document").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("observability_policies_revision_check", sql`${table.revision} > 0`)],
);

export const observabilityDestinationHealth = pgTable(
  "observability_destination_health",
  {
    destinationId: text("destination_id").primaryKey(),
    status: text("status").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "observability_destination_health_status_check",
      sql`${table.status} in ('pending', 'healthy', 'degraded', 'paused')`,
    ),
  ],
);

/**
 * Batch receipts, not archives. The `(signal, payload_hash)` unique index records
 * Collector redelivery without retaining the telemetry payload. Retention only has
 * to cover the Collector's retry window.
 */
export const otlpBatches = pgTable(
  "otlp_batches",
  {
    id: text("id").primaryKey(),
    signal: text("signal").notNull(),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("otlp_batches_signal_check", sql`${table.signal} in ('traces', 'logs', 'metrics')`),
    uniqueIndex("otlp_batches_signal_hash_idx").on(table.signal, table.payloadHash),
    index("otlp_batches_signal_received_idx").on(table.signal, table.receivedAt),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    type: text("type").notNull(),
    status: text("status").notNull(),
    payload: jsonb("payload").notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    // FIFO tiebreaker: created_at has finite resolution, so two jobs enqueued in
    // the same instant would otherwise claim in plan-dependent order.
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Completed jobs are never pruned (only project deletion removes rows), so
    // this table grows for the life of the install while the claim scan runs
    // every worker tick. Both hot predicates are partial indexes over the few
    // rows that are not already terminal.
    index("jobs_queued_claim_idx")
      .on(table.createdAt, table.sequence)
      .where(sql`${table.status} = 'queued'`),
    // Serves both the claim query's per-project mutual-exclusion subquery and
    // recoverStaleJobs' locked_at scan.
    index("jobs_running_project_idx")
      .on(table.projectId, table.lockedAt)
      .where(sql`${table.status} = 'running'`),
    // listProjectJobs: newest-first per project, over the full history.
    index("jobs_project_created_idx").on(table.projectId, table.createdAt),
  ],
);

export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
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
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  kind: text("kind").notNull(),
  commitSha: text("commit_sha"),
  sourcePath: text("source_path").notNull(),
  summary: jsonb("summary").notNull().default({}),
  envVars: jsonb("env_vars").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const releases = pgTable(
  "releases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.id),
    imageTag: text("image_tag").notNull(),
    // Null marks releases built before the observer delivery contract existed.
    observerContract: integer("observer_contract"),
    // Build-derived summary projected from eve's discovery manifest. Release-
    // scoped: the same source revision can be rebuilt into releases with
    // different resolved dependencies. Null for releases whose manifest could
    // not be read or predates this column.
    summary: jsonb("summary"),
    // Immutable workflow attestation from what release preparation actually
    // injected. No defaults: every writer must state provenance, and the
    // migration backfills historical rows with 'unknown' — which blocks
    // activation/restart/archive until the cutover classifies the artifact.
    workflowWorldKind: text("workflow_world_kind").notNull(),
    workflowWorldPackage: text("workflow_world_package"),
    workflowWorldVersion: text("workflow_world_version"),
    workflowStorageSpec: integer("workflow_storage_spec"),
    workflowDispatchProtocol: integer("workflow_dispatch_protocol"),
    workflowEnqueueCapability: text("workflow_enqueue_capability").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Postgres does not index foreign keys on its own; listReleaseSummaries
  // filters by project on every deployment-overview request.
  (table) => [index("releases_project_idx").on(table.projectId)],
);

export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id),
    containerName: text("container_name").notNull(),
    internalPort: integer("internal_port").notNull(),
    hostPort: integer("host_port").notNull(),
    status: text("status").notNull(),
    // No default: every caller must state which runtime adapter created the deployment.
    // The migration backfills existing rows with 'docker' then drops the column default.
    runtimeKind: text("runtime_kind").notNull(),
    // Mutable workflow execution topology, distinct from the Release's
    // immutable attestation. Historical rows migrate to 'unknown'/'unclassified'
    // and only a cutover operation moves them; new shared builds start at
    // 'external'/'external'.
    workflowRunnerMode: text("workflow_runner_mode").notNull(),
    workflowConversionState: text("workflow_conversion_state").notNull(),
    workflowConversionOperationId: text("workflow_conversion_operation_id"),
    workflowRunnerEvidence: jsonb("workflow_runner_evidence"),
    workflowConvertedAt: timestamp("workflow_converted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("deployments_project_key_idx").on(table.projectId, table.deploymentKey),
    check("deployments_key_check", sql`${table.deploymentKey} ~ '^[a-z0-9]{8}$'`),
  ],
);

export const projectSchedules = pgTable(
  "project_schedules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("project_schedules_project_key_idx").on(table.projectId, table.key)],
);

export const scheduleVersions = pgTable(
  "schedule_versions",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => projectSchedules.id, { onDelete: "cascade" }),
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => sourceRevisions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    cron: text("cron").notNull(),
    sourcePath: text("source_path").notNull(),
    definitionHash: text("definition_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("schedule_versions_schedule_revision_idx").on(
      table.scheduleId,
      table.sourceRevisionId,
    ),
    check("schedule_versions_kind_check", sql`${table.kind} in ('markdown', 'handler')`),
  ],
);

export const projectSchedulerTargets = pgTable("project_scheduler_targets", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  deploymentId: text("deployment_id")
    .notNull()
    .references(() => deployments.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => projectSchedules.id, { onDelete: "cascade" }),
    scheduleVersionId: text("schedule_version_id")
      .notNull()
      .references(() => scheduleVersions.id),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(0),
    missedTicks: integer("missed_ticks").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("schedule_runs_version_due_idx")
      .on(table.scheduleVersionId, table.dueAt)
      .where(sql`${table.trigger} = 'cron'`),
    index("schedule_runs_schedule_status_idx").on(table.scheduleId, table.status),
    check("schedule_runs_trigger_check", sql`${table.trigger} in ('cron', 'manual')`),
    check(
      "schedule_runs_status_check",
      sql`${table.status} in ('queued', 'activating', 'dispatching', 'running', 'succeeded', 'failed', 'dispatch_unknown', 'skipped')`,
    ),
  ],
);

export const runtimeInstances = pgTable(
  "runtime_instances",
  {
    id: text("id").primaryKey(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    status: text("status").notNull(),
    endpointHost: text("endpoint_host"),
    endpointPort: integer("endpoint_port"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("runtime_instances_deployment_generation_idx").on(
      table.deploymentId,
      table.generation,
    ),
    index("runtime_instances_deployment_status_idx").on(table.deploymentId, table.status),
    // At most one live process per loopback port, across every Deployment.
    // Reservation happens before bind (reserveRuntimeInstancePort); leaving
    // the live statuses releases the port automatically.
    uniqueIndex("runtime_instances_live_port_idx")
      .on(table.endpointPort)
      .where(
        sql`${table.status} in ('starting', 'ready', 'draining') and ${table.endpointPort} is not null`,
      ),
    check(
      "runtime_instances_status_check",
      sql`${table.status} in ('starting', 'ready', 'draining', 'stopped', 'failed')`,
    ),
  ],
);

/**
 * Fail-closed cutover/termination operations. There is no distributed
 * transaction across the control-plane and workflow databases; each operation
 * advances monotonically through
 * `pending -> fenced -> workflow_safe -> control_plane_converged -> completed`
 * with idempotent checkpoints, and any mid-phase failure leaves it fenced —
 * never back in an activatable state.
 */
export const workflowCutoverOperations = pgTable("workflow_cutover_operations", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  phase: text("phase").notNull(),
  scope: jsonb("scope").notNull(),
  checkpoints: jsonb("checkpoints").notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Terminal fences and tombstones written by a cutover/termination operation
 * before it touches any workflow database. Gateway, API, Worker and the OTLP
 * projector refuse to touch, renew, wake or re-materialize a fenced scope;
 * only explicit operator resolution closes one — never a process restart.
 *
 * scope kinds: `deployment` (activation/launch fence and projection fence for
 * permanently retired deployments), `run` (`<tenantId>:<runId>`), and
 * `session_family` (`<projectId>:<eveSessionId>` tombstone for late OTLP).
 */
export const workflowFences = pgTable(
  "workflow_fences",
  {
    id: text("id").primaryKey(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    operationId: text("operation_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (table) => [uniqueIndex("workflow_fences_scope_idx").on(table.scopeKind, table.scopeId)],
);

/**
 * Machine-readable dispatcher readiness. One row per dispatcher instance,
 * written only through the authenticated heartbeat; the newest heartbeat is
 * the authority. Identity fields never carry credentials.
 */
export const workflowDispatcherRegistrations = pgTable("workflow_dispatcher_registrations", {
  instanceId: text("instance_id").primaryKey(),
  generation: text("generation").notNull(),
  state: text("state").notNull(),
  ownershipAcquired: boolean("ownership_acquired").notNull(),
  bootRecoveryCompleted: boolean("boot_recovery_completed").notNull(),
  reenqueuedRuns: integer("reenqueued_runs"),
  worldDatabaseIdentity: text("world_database_identity").notNull(),
  schemaGeneration: text("schema_generation"),
  protocolMin: integer("protocol_min").notNull(),
  protocolMax: integer("protocol_max").notNull(),
  cutoverOperationId: text("cutover_operation_id"),
  unscopedRunnableJobs: integer("unscoped_runnable_jobs"),
  unresolvedQuarantines: integer("unresolved_quarantines"),
  desiredState: text("desired_state").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull(),
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  intervalMs: integer("interval_ms").notNull(),
  lastTickDurationMs: integer("last_tick_duration_ms").notNull(),
  lastError: text("last_error"),
  maxConcurrentHeavyJobs: integer("max_concurrent_heavy_jobs"),
});

export const hostMetricSamples = pgTable(
  "host_metric_samples",
  {
    id: text("id").primaryKey(),
    workerId: text("worker_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    cpuPercent: doublePrecision("cpu_percent"),
    load1: doublePrecision("load_1").notNull(),
    memoryTotalBytes: bigint("memory_total_bytes", { mode: "number" }).notNull(),
    memoryAvailableBytes: bigint("memory_available_bytes", { mode: "number" }).notNull(),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }).notNull(),
    diskAvailableBytes: bigint("disk_available_bytes", { mode: "number" }).notNull(),
    diskInodesTotal: bigint("disk_inodes_total", { mode: "number" }),
    diskInodesAvailable: bigint("disk_inodes_available", { mode: "number" }),
    cpuCores: integer("cpu_cores"),
    pgConnections: jsonb("pg_connections").$type<PgInstanceConnectionSample[]>(),
  },
  (table) => [
    uniqueIndex("host_metric_samples_worker_observed_idx").on(table.workerId, table.observedAt),
    index("host_metric_samples_observed_idx").on(table.observedAt),
  ],
);

export const activationLeases = pgTable(
  "activation_leases",
  {
    id: text("id").primaryKey(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    runtimeInstanceId: text("runtime_instance_id").references(() => runtimeInstances.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    ownerId: text("owner_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("activation_leases_deployment_kind_owner_idx").on(
      table.deploymentId,
      table.kind,
      table.ownerId,
    ),
    index("activation_leases_active_idx").on(table.deploymentId, table.expiresAt, table.releasedAt),
    check(
      "activation_leases_kind_check",
      sql`${table.kind} in ('public_request', 'stream', 'turn', 'schedule_run', 'workflow_step')`,
    ),
  ],
);

export const agentRoutes = pgTable(
  "agent_routes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
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
    routeId: text("route_id")
      .notNull()
      .references(() => agentRoutes.id),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id),
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
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    eveSessionId: text("eve_session_id").notNull(),
    routeId: text("route_id")
      .notNull()
      .references(() => agentRoutes.id),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id),
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
  (table) => [
    uniqueIndex("session_bindings_project_eve_idx").on(table.projectId, table.eveSessionId),
  ],
);

export const operationBindings = pgTable(
  "operation_bindings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    operationKey: text("operation_key").notNull(),
    routeId: text("route_id")
      .notNull()
      .references(() => agentRoutes.id),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id),
    trigger: text("trigger").notNull(),
    variantName: text("variant_name"),
    experimentId: text("experiment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("operation_bindings_project_key_idx").on(table.projectId, table.operationKey),
    check("operation_bindings_trigger_check", sql`${table.trigger} in ('api', 'playground')`),
  ],
);

export const sourceFiles = pgTable(
  "source_files",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => sourceRevisions.id),
    path: text("path").notNull(),
    content: text("content").notNull(),
    size: integer("size").notNull(),
  },
  (table) => [uniqueIndex("source_files_revision_path_idx").on(table.revisionId, table.path)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    deploymentId: text("deployment_id"),
    eveSessionId: text("eve_session_id"),
    rootNodeId: text("root_node_id"),
    routeId: text("route_id").references(() => agentRoutes.id),
    experimentId: text("experiment_id"),
    variantName: text("variant_name"),
    trigger: text("trigger").notNull(),
    scheduleId: text("schedule_id"),
    scheduleRunId: text("schedule_run_id").references(() => scheduleRuns.id),
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
  },
  (table) => [
    index("sessions_schedule_run_idx").on(table.scheduleRunId),
    index("sessions_project_started_idx").on(table.projectId, table.startedAt),
    // Durable Eve session identity is project-scoped: every OTLP ingest and
    // every continuation resolves a Session through this pair.
    index("sessions_project_eve_session_idx").on(table.projectId, table.eveSessionId),
  ],
);

export const scheduleRunSessions = pgTable(
  "schedule_run_sessions",
  {
    scheduleRunId: text("schedule_run_id")
      .notNull()
      .references(() => scheduleRuns.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scheduleRunId, table.sessionId] }),
    index("schedule_run_sessions_status_idx").on(table.scheduleRunId, table.status),
    check(
      "schedule_run_sessions_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'parked')`,
    ),
  ],
);

export const sessionNodes = pgTable(
  "session_nodes",
  {
    id: text("id").primaryKey(),
    rootSessionId: text("root_session_id")
      .notNull()
      .references(() => sessions.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    eveSessionId: text("eve_session_id").notNull(),
    parentNodeId: text("parent_node_id"),
    parentEveSessionId: text("parent_eve_session_id"),
    startedDeploymentId: text("started_deployment_id")
      .notNull()
      .references(() => deployments.id),
    lastObservedDeploymentId: text("last_observed_deployment_id")
      .notNull()
      .references(() => deployments.id),
    startedRuntimeInstanceId: text("started_runtime_instance_id").references(
      () => runtimeInstances.id,
      { onDelete: "set null" },
    ),
    lastObservedRuntimeInstanceId: text("last_observed_runtime_instance_id").references(
      () => runtimeInstances.id,
      { onDelete: "set null" },
    ),
    agentId: text("agent_id"),
    agentName: text("agent_name"),
    nodeId: text("node_id"),
    channelKind: text("channel_kind"),
    modelId: text("model_id"),
    observedModelId: text("observed_model_id"),
    eveVersion: text("eve_version"),
    remoteUrl: text("remote_url"),
    resolutionStatus: text("resolution_status").notNull().default("observed"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("session_nodes_project_eve_idx").on(table.projectId, table.eveSessionId),
    index("session_nodes_project_model_idx").on(table.projectId, table.modelId),
    // Every node listing, prune, and subagent re-parent walks a root Session.
    index("session_nodes_root_session_idx").on(table.rootSessionId, table.createdAt),
    index("session_nodes_last_runtime_idx").on(table.lastObservedRuntimeInstanceId, table.status),
  ],
);

export const modelUsageEvents = pgTable(
  "model_usage_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    sessionNodeId: text("session_node_id").references(() => sessionNodes.id),
    eveSessionId: text("eve_session_id").notNull(),
    agentId: text("agent_id"),
    agentName: text("agent_name"),
    turnId: text("turn_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    modelId: text("model_id"),
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
    uniqueIndex("model_usage_session_eve_turn_step_idx").on(
      table.sessionId,
      table.eveSessionId,
      table.turnId,
      table.stepIndex,
    ),
    uniqueIndex("model_usage_node_turn_step_idx").on(
      table.sessionNodeId,
      table.turnId,
      table.stepIndex,
    ),
    index("model_usage_created_idx").on(table.createdAt),
  ],
);

export const sessionEvents = pgTable(
  "session_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    sessionNodeId: text("session_node_id").references(() => sessionNodes.id),
    telemetryEventId: text("telemetry_event_id"),
    eventFingerprint: text("event_fingerprint"),
    observedDeploymentId: text("observed_deployment_id").references(() => deployments.id),
    observedRuntimeInstanceId: text("observed_runtime_instance_id").references(
      () => runtimeInstances.id,
      { onDelete: "set null" },
    ),
    sourceSequence: integer("source_sequence"),
    index: integer("index").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    eventAt: timestamp("event_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("session_events_node_telemetry_idx").on(
      table.sessionNodeId,
      table.telemetryEventId,
    ),
    uniqueIndex("session_events_node_fingerprint_idx").on(
      table.sessionNodeId,
      table.eventFingerprint,
    ),
    // `index` is the replay/transcript ordering key, so a duplicate silently
    // corrupts event order. Appends serialize on the parent Session row; this
    // constraint is the backstop that makes any path which forgets to do so
    // fail loudly instead. It also serves `where session_id = ? order by index`.
    uniqueIndex("session_events_session_index_idx").on(table.sessionId, table.index),
  ],
);

export const logs = pgTable(
  "logs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    deploymentId: text("deployment_id"),
    type: text("type").notNull(),
    line: text("line").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // listLogs is always project-scoped and ordered by time; the optional type
    // filter stays a residual on top of this.
    index("logs_project_created_idx").on(table.projectId, table.createdAt),
  ],
);
