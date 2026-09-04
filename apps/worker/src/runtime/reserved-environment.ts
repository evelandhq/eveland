/**
 * The environment names the platform owns at runtime, in one place.
 *
 * `composeDeploymentEnv` builds these into its `reserved` layer, which
 * `mergeRuntimeEnvironment` applies last so a project cannot redirect the
 * injected workflow world, forge its own project id, or raise its share of the
 * shared Postgres connection budget. Nothing rejects these names at write time
 * -- an operator may declare an entry called `NODE_ENV` or
 * `WORKFLOW_POSTGRES_URL` -- so the runtime defends itself by precedence.
 *
 * A Release build has no equivalent layer, which is why the list is exported
 * here rather than living inline: a build that adopted the project's value for
 * one of these names would compile against something the deployed process then
 * overrides. That is the same build/runtime divergence
 * ./build-environment.ts exists to close, so the build drops them too.
 *
 * Kept in sync with composeDeploymentEnv's `reserved` object by
 * ../jobs/process-support-reserved.test.ts, which fails if either side gains a
 * name the other does not have.
 */
export const RESERVED_RUNTIME_ENVIRONMENT_KEYS: readonly string[] = [
  "EVELAND_IDENTITY_ISSUER",
  "EVELAND_IDENTITY_JWKS_URL",
  // Where the deployed process persists fileMemory() documents. A project that
  // could set it would point the agent's durable memory at an unprovisioned
  // path -- or, worse, at a directory shared with another tenant.
  "EVELAND_MEMORY_ROOT",
  "EVELAND_PROJECT_ID",
  "EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES",
  "EVELAND_SANDBOX_MAX_OUTPUT_BYTES",
  "EVELAND_SANDBOX_RUN_TIMEOUT_MS",
  "EVELAND_SCHEDULER_REDEEM_URL",
  "EVELAND_SCHEDULER_RUNTIME_SECRET",
  // Tenancy and topology for the platform workflow world. A project that could
  // set these could scope its world at another tenant's data, or hand the
  // runner a database nothing provisions.
  "EVELAND_WORKFLOW_RUNNER",
  "EVELAND_WORKFLOW_STREAM_COMPACTION",
  "EVELAND_WORKFLOW_WORLD_URL",
  // Reserved at runtime only in production, but reserved for every build
  // regardless: `npm ci` and `pnpm install --frozen-lockfile` both omit
  // devDependencies when NODE_ENV=production is in the environment, so an entry
  // carrying it would strip the project's own build toolchain out of the
  // install that `npx eve build` then runs against.
  "NODE_ENV",
  // The drain budget a platform-initiated stop honours. A project that could
  // set it could make every restart an instant kill, or claim more grace than
  // `eve start` will ever wait for. See ./shutdown-budget.ts.
  "SERVER_SHUTDOWN_TIMEOUT",
  "WORKFLOW_POSTGRES_MAX_POOL_SIZE",
  "WORKFLOW_POSTGRES_URL",
];
