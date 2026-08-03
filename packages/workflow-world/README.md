# `@eveland/workflow-world`

A natively multi-tenant [Workflow](https://github.com/vercel/workflow) `World`
for the Eveland platform. Orchestration is shared; execution stays inside each
agent deployment.

> **Experimental (0.x).** This exists to serve Eveland's own deployments and
> tracks the `@workflow/*` beta line, which still changes shape between
> releases. Pin an exact version.

## What it is

A drop-in replacement for `@workflow/world-postgres` that does two things
differently:

- **One database for every project**, with tenancy as a `tenant_id` column
  rather than a database per project. The two append-heavy tables
  (`workflow_events`, `workflow_stream_chunks`) are LIST-partitioned by tenant,
  so deleting a project is a `DROP TABLE` of its partitions rather than an
  unbounded `DELETE`.
- **A choice of who runs the queue.** In `embedded` mode the world runs its own
  graphile-worker in-process, exactly as world-postgres does. In `external` mode
  it starts no runner: the platform dispatcher claims the tenant's jobs and
  POSTs each step back in.

That second point is the reason the package exists. With the runner inside the
agent process, a durable timer only fires while that process happens to be
alive — so `sleep('1h')` on a quiet project resumes when unrelated traffic
wakes the agent, or never.

## Usage

The platform injects this at build time; you should not need to configure it by
hand. For local work:

```ts
import { createWorld } from "@eveland/workflow-world";

export default {
  experimental: {
    workflow: { world: "@eveland/workflow-world" },
  },
};
```

Configuration comes from the environment:

| Variable                     | Meaning                                              |
| ---------------------------- | ---------------------------------------------------- |
| `EVELAND_WORKFLOW_WORLD_URL` | Shared Postgres database                             |
| `EVELAND_PROJECT_ID`         | Tenant id — scopes every read and write              |
| `EVELAND_DEPLOYMENT_ID`      | Recorded on runs; pins in-flight runs to an executor |
| `EVELAND_WORKFLOW_RUNNER`    | `embedded` (default) or `external`                   |

Provisioning, once per database and once per project:

```bash
npx eveland-workflow-world-setup   # migrations + graphile schema
```

```ts
import { ensureTenantPartitions } from "@eveland/workflow-world";
await ensureTenantPartitions(pool, projectId);
```

There is deliberately **no `DEFAULT` partition**: writing for a tenant that was
never provisioned raises an error rather than quietly landing rows somewhere
that cannot later be reclaimed.

## Tenancy

Every query carries the ambient tenant. That includes `hooks.getByToken`, whose
only argument is a token — it is scoped by tenant _and_ token, so guessing
another project's token resolves to nothing rather than to their hook.

The boundary is WHERE-clause discipline, not row-level security. That is
adequate against accidents and is what the isolation tests in
`src/world.integration.test.ts` hold in place; it is not a hostile-tenant
boundary. Run those tests with `EVELAND_WORKFLOW_WORLD_TEST_URL` pointed at a
scratch database.

## Relationship to upstream

The storage, streamer and queue modules are ports of `@workflow/world-postgres`,
kept deliberately close to the original so upstream fixes stay easy to follow.
The event-sourcing logic is upstream's. What changed: tenant scoping throughout,
per-tenant NOTIFY channels, per-tenant graphile job names in embedded mode, a
real `getDeploymentId()`, and a tenant-scoped startup re-enqueue in place of
`reenqueueActiveRuns`.

## License

Apache-2.0, matching the upstream world it derives from.
