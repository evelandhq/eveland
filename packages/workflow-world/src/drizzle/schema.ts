import {
  type Event,
  type Hook,
  type SerializedData,
  type Step,
  StepStatusSchema,
  type Wait,
  WaitStatusSchema,
  type WorkflowRun,
  WorkflowRunStatusSchema,
} from "@workflow/world";
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  /** @deprecated: use Cbor instead */
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { Cbor, type Cborized } from "./cbor.js";

export const schema = pgSchema("workflow");

function mustBeMoreThanOne<T>(t: T[]) {
  return t as [T, ...T[]];
}

export const workflowRunStatus = schema.enum(
  "status",
  mustBeMoreThanOne(WorkflowRunStatusSchema.options),
);

export const stepStatus = schema.enum("step_status", mustBeMoreThanOne(StepStatusSchema.options));

export const waitStatus = schema.enum("wait_status", mustBeMoreThanOne(WaitStatusSchema.options));

/**
 * A mapped type that converts all properties of T to Drizzle ORM column
 * definitions, marking them as not nullable if they are not optional in T.
 */
type DrizzlishOfType<T extends object> = {
  [key in keyof T]-?: undefined extends T[key]
    ? { _: { notNull: boolean } }
    : { _: { notNull: true } };
};

/**
 * Upstream's own escape hatch, kept verbatim: the serialized payload columns are
 * `any[]` there, and the storage layer relies on `any`'s assignability when it
 * casts an execution context into this type. Narrowing it to `unknown[]` breaks
 * those casts without making the data any better typed.
 */
// oxlint-disable-next-line no-explicit-any
export type SerializedContent = any[];

/**
 * `tenant_id` is part of every primary key, not merely an extra column.
 *
 * On the partitioned tables Postgres *requires* it — a primary key or unique
 * index on a partitioned table must contain the partition key. On the
 * unpartitioned ones it is a correctness choice: run and step ids are supplied
 * by the runtime, so a bare `id` primary key would let one tenant's insert fail
 * against another tenant's row, which both breaks the write and leaks the
 * existence of that row.
 */
export const runs = schema.table(
  "workflow_runs",
  {
    tenantId: varchar("tenant_id").notNull(),
    runId: varchar("id").notNull(),
    /** @deprecated */
    outputJson: jsonb("output").$type<SerializedContent>(),
    output: Cbor<SerializedContent>()("output_cbor"),
    deploymentId: varchar("deployment_id").notNull(),
    status: workflowRunStatus("status").notNull(),
    workflowName: varchar("name").notNull(),
    specVersion: integer("spec_version"),
    /** @deprecated */
    executionContextJson: jsonb("execution_context").$type<Record<string, unknown>>(),
    executionContext: Cbor<Record<string, unknown>>()("execution_context_cbor"),
    /** @deprecated */
    inputJson: jsonb("input").$type<SerializedContent>(),
    input: Cbor<SerializedContent>()("input_cbor"),
    /** @deprecated - use error instead (legacy JSON-stringified StructuredError) */
    errorJson: text("error"),
    error: Cbor<SerializedData>()("error_cbor"),
    errorCode: varchar("error_code"),
    attributes: jsonb("attributes").$type<Record<string, string>>().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    completedAt: timestamp("completed_at"),
    startedAt: timestamp("started_at"),
    expiredAt: timestamp("expired_at"),
  },
  (tb) => [
    primaryKey({ columns: [tb.tenantId, tb.runId] }),
    index("workflow_runs_name_index").on(tb.workflowName),
    index("workflow_runs_tenant_status_index").on(tb.tenantId, tb.status),
    index("workflow_runs_tenant_created_index").on(tb.tenantId, tb.createdAt),
    /**
     * The deployment retention guard's only query: which deployments still own
     * a run that has not finished. Partial so it stays small as terminal runs
     * accumulate — this table is append-mostly and never pruned.
     */
    index("workflow_runs_active_deployment_index")
      .on(tb.deploymentId)
      .where(sql`status in ('pending', 'running')`),
  ],
);

export const events = schema.table(
  "workflow_events",
  {
    tenantId: varchar("tenant_id").notNull(),
    eventId: varchar("id").notNull(),
    eventType: varchar("type").$type<Event["eventType"]>().notNull(),
    correlationId: varchar("correlation_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    runId: varchar("run_id").notNull(),
    /** @deprecated */
    eventDataJson: jsonb("payload"),
    eventData: Cbor<unknown>()("payload_cbor"),
    specVersion: integer("spec_version"),
  },
  (tb) => [
    primaryKey({ columns: [tb.tenantId, tb.eventId] }),
    index("workflow_events_tenant_run_index").on(tb.tenantId, tb.runId),
    index("workflow_events_tenant_correlation_index").on(tb.tenantId, tb.correlationId),
    /**
     * Runtime-correlated one-shot events must be unique per (run, correlation)
     * — without this, two concurrent invocations producing identical
     * correlationIds (e.g. the snapshot runtime's deterministic ULIDs across
     * replays) can both insert events, causing duplicate operations in the log.
     * The unique violation is caught in events.create and translated to
     * EntityConflictError, matching the runtime's expected dedup contract.
     *
     * `tenantId` leads because the table is partitioned by it.
     */
    uniqueIndex("workflow_events_entity_creation_unique")
      .on(tb.tenantId, tb.runId, tb.correlationId, tb.eventType)
      .where(sql`type IN ('step_created', 'hook_created', 'wait_created', 'attr_set')`),
  ],
);

export const steps = schema.table(
  "workflow_steps",
  {
    tenantId: varchar("tenant_id").notNull(),
    runId: varchar("run_id").notNull(),
    stepId: varchar("step_id").notNull(),
    stepName: varchar("step_name").notNull(),
    status: stepStatus("status").notNull(),
    /** @deprecated */
    inputJson: jsonb("input").$type<SerializedContent>(),
    input: Cbor<SerializedContent>()("input_cbor"),
    /** @deprecated we stream binary data */
    outputJson: jsonb("output").$type<SerializedContent>(),
    output: Cbor<SerializedContent>()("output_cbor"),
    /** @deprecated - use error instead (legacy JSON-stringified StructuredError) */
    errorJson: text("error"),
    error: Cbor<SerializedData>()("error_cbor"),
    attempt: integer("attempt").notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    retryAfter: timestamp("retry_after"),
    specVersion: integer("spec_version"),
  },
  (tb) => [
    primaryKey({ columns: [tb.tenantId, tb.stepId] }),
    index("workflow_steps_tenant_run_index").on(tb.tenantId, tb.runId),
    index("workflow_steps_tenant_status_index").on(tb.tenantId, tb.status),
  ],
);

export const hooks = schema.table(
  "workflow_hooks",
  {
    tenantId: varchar("tenant_id").notNull(),
    runId: varchar("run_id").notNull(),
    hookId: varchar("hook_id").notNull(),
    token: varchar("token").notNull(),
    ownerId: varchar("owner_id").notNull(),
    /**
     * Upstream's column, not Eveland's tenancy. world-postgres writes the empty
     * string into it; it is carried so a run created by either world reads back
     * identically. Tenancy is `tenantId`.
     */
    projectId: varchar("project_id").notNull(),
    environment: varchar("environment").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** @deprecated */
    metadataJson: jsonb("metadata").$type<SerializedContent>(),
    metadata: Cbor<SerializedContent>()("metadata_cbor"),
    specVersion: integer("spec_version"),
    isWebhook: boolean("is_webhook").default(true),
    isSystem: boolean("is_system").default(false),
  },
  (tb) => [
    primaryKey({ columns: [tb.tenantId, tb.hookId] }),
    index("workflow_hooks_tenant_run_index").on(tb.tenantId, tb.runId),
    index("workflow_hooks_tenant_token_index").on(tb.tenantId, tb.token),
  ],
);

export const waits = schema.table(
  "workflow_waits",
  {
    tenantId: varchar("tenant_id").notNull(),
    waitId: varchar("wait_id").notNull(),
    runId: varchar("run_id").notNull(),
    status: waitStatus("status").notNull(),
    resumeAt: timestamp("resume_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdateFn(() => new Date())
      .notNull(),
    specVersion: integer("spec_version"),
  },
  (tb) => [
    primaryKey({ columns: [tb.tenantId, tb.waitId] }),
    index("workflow_waits_tenant_run_index").on(tb.tenantId, tb.runId),
  ],
);

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const streams = schema.table(
  "workflow_stream_chunks",
  {
    tenantId: varchar("tenant_id").notNull(),
    chunkId: varchar("id").$type<`chnk_${string}`>().notNull(),
    streamId: varchar("stream_id").notNull(),
    runId: varchar("run_id"),
    chunkData: bytea("data").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    eof: boolean("eof").notNull(),
  },
  (tb) => [
    primaryKey({ columns: [tb.tenantId, tb.streamId, tb.chunkId] }),
    index("workflow_stream_chunks_tenant_run_index").on(tb.tenantId, tb.runId),
  ],
);

/**
 * Type-level assertions that the tables still cover the shapes the Workflow
 * runtime expects. Kept as `satisfies` checks on standalone constants rather
 * than inline on the table literals so the tenancy columns above do not have to
 * be threaded through upstream's types.
 */
type _RunColumns = DrizzlishOfType<
  Cborized<
    Omit<WorkflowRun, "input"> & { input?: unknown },
    "input" | "output" | "executionContext" | "error"
  >
>;
type _EventColumns = DrizzlishOfType<
  Cborized<Omit<Event, "occurredAt"> & { eventData?: undefined }, "eventData">
>;
type _StepColumns = DrizzlishOfType<
  Cborized<Omit<Step, "input"> & { input?: unknown }, "output" | "input" | "error">
>;
type _HookColumns = DrizzlishOfType<Cborized<Hook, "metadata">>;
type _WaitColumns = DrizzlishOfType<Wait>;
export type SchemaShapeChecks = [
  _RunColumns,
  _EventColumns,
  _StepColumns,
  _HookColumns,
  _WaitColumns,
];

/** Tables that are LIST-partitioned by `tenant_id`. */
export const PARTITIONED_TABLES = ["workflow_events", "workflow_stream_chunks"] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];
