-- Eveland multi-tenant workflow world, initial schema.
--
-- Differences from @workflow/world-postgres, which this is ported from:
--   * every table carries `tenant_id` (the Eveland project id) and it leads
--     every primary key;
--   * `workflow_events` and `workflow_stream_chunks` are LIST-partitioned by
--     `tenant_id`, so deleting a project is a DROP TABLE of its partitions
--     rather than an unbounded DELETE (issue #213);
--   * the enums live in the `workflow` schema from the start, rather than being
--     created in `public` and moved later;
--   * `workflow_runs.status` has no `paused` value — upstream removed it.

create schema if not exists workflow;

do $$ begin
  create type workflow.status as enum ('pending', 'running', 'completed', 'failed', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type workflow.step_status as enum ('pending', 'running', 'completed', 'failed', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type workflow.wait_status as enum ('waiting', 'completed');
exception when duplicate_object then null;
end $$;

create table if not exists workflow.workflow_runs (
  tenant_id varchar not null,
  id varchar not null,
  output jsonb,
  output_cbor bytea,
  deployment_id varchar not null,
  status workflow.status not null,
  name varchar not null,
  spec_version integer,
  execution_context jsonb,
  execution_context_cbor bytea,
  input jsonb,
  input_cbor bytea,
  error text,
  error_cbor bytea,
  error_code varchar,
  attributes jsonb default '{}'::jsonb not null,
  created_at timestamp default now() not null,
  updated_at timestamp default now() not null,
  completed_at timestamp,
  started_at timestamp,
  expired_at timestamp,
  constraint workflow_runs_pkey primary key (tenant_id, id)
);

create index if not exists workflow_runs_name_index
  on workflow.workflow_runs (name);
create index if not exists workflow_runs_tenant_status_index
  on workflow.workflow_runs (tenant_id, status);
create index if not exists workflow_runs_tenant_created_index
  on workflow.workflow_runs (tenant_id, created_at);

-- The deployment retention guard's only query. Partial, because the table is
-- append-mostly: the share of rows that are still pending or running stays
-- small even as the run history grows without bound.
create index if not exists workflow_runs_active_deployment_index
  on workflow.workflow_runs (deployment_id)
  where status in ('pending', 'running');

create table if not exists workflow.workflow_steps (
  tenant_id varchar not null,
  run_id varchar not null,
  step_id varchar not null,
  step_name varchar not null,
  status workflow.step_status not null,
  input jsonb,
  input_cbor bytea,
  output jsonb,
  output_cbor bytea,
  error text,
  error_cbor bytea,
  attempt integer not null,
  started_at timestamp,
  completed_at timestamp,
  created_at timestamp default now() not null,
  updated_at timestamp default now() not null,
  retry_after timestamp,
  spec_version integer,
  constraint workflow_steps_pkey primary key (tenant_id, step_id)
);

create index if not exists workflow_steps_tenant_run_index
  on workflow.workflow_steps (tenant_id, run_id);
create index if not exists workflow_steps_tenant_status_index
  on workflow.workflow_steps (tenant_id, status);

create table if not exists workflow.workflow_hooks (
  tenant_id varchar not null,
  run_id varchar not null,
  hook_id varchar not null,
  token varchar not null,
  owner_id varchar not null,
  -- Upstream's own column, distinct from `tenant_id`. world-postgres writes the
  -- empty string into it; it is preserved so a run reads back identically
  -- whichever world wrote it.
  project_id varchar not null,
  environment varchar not null,
  created_at timestamp default now() not null,
  metadata jsonb,
  metadata_cbor bytea,
  spec_version integer,
  is_webhook boolean default true,
  is_system boolean default false,
  constraint workflow_hooks_pkey primary key (tenant_id, hook_id)
);

create index if not exists workflow_hooks_tenant_run_index
  on workflow.workflow_hooks (tenant_id, run_id);
create index if not exists workflow_hooks_tenant_token_index
  on workflow.workflow_hooks (tenant_id, token);

create table if not exists workflow.workflow_waits (
  tenant_id varchar not null,
  wait_id varchar not null,
  run_id varchar not null,
  status workflow.wait_status not null,
  resume_at timestamp,
  completed_at timestamp,
  created_at timestamp default now() not null,
  updated_at timestamp default now() not null,
  spec_version integer,
  constraint workflow_waits_pkey primary key (tenant_id, wait_id)
);

create index if not exists workflow_waits_tenant_run_index
  on workflow.workflow_waits (tenant_id, run_id);

-- Partitioned tables ---------------------------------------------------------
--
-- No DEFAULT partition, deliberately. Attaching a new partition while a default
-- exists forces Postgres to scan the default for rows that belong in the new
-- one, which would turn project creation into an O(fleet) operation. Without a
-- default, writing for a tenant whose partition is missing raises
-- `no partition of relation ... found for row` — the correct outcome, because
-- the partition is created during project provisioning.

create table if not exists workflow.workflow_events (
  tenant_id varchar not null,
  id varchar not null,
  type varchar not null,
  correlation_id varchar,
  created_at timestamp default now() not null,
  run_id varchar not null,
  payload jsonb,
  payload_cbor bytea,
  spec_version integer,
  constraint workflow_events_pkey primary key (tenant_id, id)
) partition by list (tenant_id);

create index if not exists workflow_events_tenant_run_index
  on workflow.workflow_events (tenant_id, run_id);
create index if not exists workflow_events_tenant_correlation_index
  on workflow.workflow_events (tenant_id, correlation_id);

-- Runtime-correlated one-shot events must be unique per (run, correlation).
-- Without this, two concurrent invocations producing identical correlationIds
-- can both insert, duplicating operations in the log. `events.create`
-- translates the unique violation into EntityConflictError, which is the dedup
-- contract the runtime expects.
create unique index if not exists workflow_events_entity_creation_unique
  on workflow.workflow_events (tenant_id, run_id, correlation_id, type)
  where type in ('step_created', 'hook_created', 'wait_created', 'attr_set');

create table if not exists workflow.workflow_stream_chunks (
  tenant_id varchar not null,
  id varchar not null,
  stream_id varchar not null,
  run_id varchar,
  data bytea not null,
  created_at timestamp default now() not null,
  eof boolean not null,
  constraint workflow_stream_chunks_pkey primary key (tenant_id, stream_id, id)
) partition by list (tenant_id);

create index if not exists workflow_stream_chunks_tenant_run_index
  on workflow.workflow_stream_chunks (tenant_id, run_id);
