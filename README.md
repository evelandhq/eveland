# Eveland

Self-hosted control plane for importing, deploying, and observing `eve` projects.

## Current MVP Slice

- `packages/shared`: tested core behavior for IDs, archive path safety, eve source inspection, schedule parsing, next-run calculation, secret encryption, and runtime command inference.
- `apps/api`: Hono API with the public project/secrets/schedules/sessions/logs contract, BetterAuth dependency, Drizzle/Postgres schema, and Postgres-backed store when `DATABASE_URL` is set.
- `apps/worker`: Docker runtime adapter, Postgres job consumer, and worker processors for import/build/restart/schedule job state transitions.
- `apps/web`: Next.js App Router control panel using the requested shadcn preset and Tailwind v4.

## Local Development

```bash
pnpm install
pnpm --filter @eveland/api dev
pnpm --filter @eveland/web dev
pnpm --filter @eveland/worker dev
```

Open `http://localhost:3000`.

Docker Compose is available for the full service set:

```bash
docker compose up
```

## Verification

```bash
pnpm test
pnpm typecheck
```

## Notes

- API uses Postgres when `DATABASE_URL` is set; tests use the memory store.
- `apps/api/src/db/schema.ts` and `apps/api/drizzle/` are the Postgres model and migration targets.
- Markdown eve schedules are executable in the MVP plan; TypeScript schedules are discovery-only until the native eve schedule runtime is integrated.
