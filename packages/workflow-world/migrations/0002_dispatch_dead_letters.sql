-- Jobs that exhausted graphile's `maxAttempts` land here.
--
-- Without this the run simply stops: graphile marks the job permanently failed
-- and nothing else in the system knows the run is stranded. A run that could
-- have succeeded is an operator problem rather than a workflow outcome, so the
-- message is preserved verbatim and can be replayed by hand once the cause is
-- fixed — rather than being turned into a `run_failed` event the workflow author
-- would have to interpret.
create table if not exists workflow.dispatch_dead_letters (
  id bigserial primary key,
  tenant_id varchar not null,
  deployment_id varchar,
  run_id varchar,
  message_id varchar not null,
  job_name varchar not null,
  queue_name varchar not null,
  attempt integer not null,
  reason text not null,
  payload jsonb not null,
  created_at timestamptz default now() not null,
  resolved_at timestamptz
);

create index if not exists dispatch_dead_letters_tenant_index
  on workflow.dispatch_dead_letters (tenant_id, created_at desc);

-- The alarm query: anything unresolved is work the platform has dropped.
create index if not exists dispatch_dead_letters_unresolved_index
  on workflow.dispatch_dead_letters (created_at)
  where resolved_at is null;
