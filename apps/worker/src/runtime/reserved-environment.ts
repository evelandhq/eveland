/**
 * The environment names the platform owns at runtime, and what each one is
 * derived from, in one place.
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
 * Each name maps to the worker-environment variables its value is derived
 * from, which is what ./platform-runtime-config-reconciler.ts fingerprints.
 * The mapping is deliberately in terms of *inputs* rather than composed
 * values: composing the real thing means provisioning tenants and databases
 * and decrypting a project's secrets, none of which belongs on the worker's
 * boot path. A name with no inputs is derived entirely per project and can
 * never drift out from under a running Deployment.
 *
 * Kept in sync with composeDeploymentEnv's `reserved` object by
 * ../jobs/process-support-reserved.test.ts, which fails if either side gains a
 * name the other does not have -- and which also fails on a name added here
 * without its inputs, so a new reserved value cannot silently escape the
 * drift check the way every non-Identity name did before issue #477.
 */
export const RESERVED_RUNTIME_ENVIRONMENT_SOURCES: Readonly<Record<string, readonly string[]>> = {
  // The issuer falls back to EVELAND_PUBLIC_ORIGIN, and both it and the JWKS
  // URL have production-only fallbacks keyed off NODE_ENV.
  EVELAND_IDENTITY_ISSUER: ["EVELAND_IDENTITY_ISSUER", "EVELAND_PUBLIC_ORIGIN", "NODE_ENV"],
  EVELAND_IDENTITY_JWKS_URL: [
    "EVELAND_IDENTITY_JWKS_URL",
    "EVELAND_IDENTITY_ISSUER",
    "EVELAND_PUBLIC_ORIGIN",
    "NODE_ENV",
  ],
  // Where the deployed process persists fileMemory() documents. A project that
  // could set it would point the agent's durable memory at an unprovisioned
  // path -- or, worse, at a directory shared with another tenant. Derived from
  // the data root (the host one when the worker itself runs in Compose).
  EVELAND_MEMORY_ROOT: ["EVELAND_DATA_DIR", "EVELAND_HOST_DATA_DIR"],
  // Per project by construction; no platform input can change it.
  EVELAND_PROJECT_ID: [],
  EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES: ["EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES"],
  EVELAND_SANDBOX_MAX_OUTPUT_BYTES: ["EVELAND_SANDBOX_MAX_OUTPUT_BYTES"],
  EVELAND_SANDBOX_RUN_TIMEOUT_MS: ["EVELAND_SANDBOX_RUN_TIMEOUT_MS"],
  EVELAND_SCHEDULER_REDEEM_URL: ["EVELAND_SCHEDULER_REDEEM_URL"],
  // The development fallback is keyed off NODE_ENV, so a production flip
  // changes the secret even when the variable itself does not.
  EVELAND_SCHEDULER_RUNTIME_SECRET: ["EVELAND_SCHEDULER_RUNTIME_SECRET", "NODE_ENV"],
  // Tenancy and topology for the platform workflow world. A project that could
  // set these could scope its world at another tenant's data, or hand the
  // runner a database nothing provisions.
  EVELAND_WORKFLOW_RUNNER: ["EVELAND_WORKFLOW_RUNNER"],
  EVELAND_WORKFLOW_STREAM_COMPACTION: ["EVELAND_WORKFLOW_STREAM_COMPACTION"],
  EVELAND_WORKFLOW_WORLD_URL: ["EVELAND_WORKFLOW_WORLD_URL"],
  // Reserved at runtime only in production, but reserved for every build
  // regardless: `npm ci` and `pnpm install --frozen-lockfile` both omit
  // devDependencies when NODE_ENV=production is in the environment, so an entry
  // carrying it would strip the project's own build toolchain out of the
  // install that `npx eve build` then runs against.
  NODE_ENV: ["NODE_ENV"],
  // The drain budget a platform-initiated stop honours. A project that could
  // set it could make every restart an instant kill, or claim more grace than
  // `eve start` will ever wait for. See ./shutdown-budget.ts.
  SERVER_SHUTDOWN_TIMEOUT: ["EVELAND_DEPLOYMENT_SHUTDOWN_TIMEOUT_SECONDS"],
  WORKFLOW_POSTGRES_MAX_POOL_SIZE: ["WORKFLOW_POSTGRES_MAX_POOL_SIZE"],
  // The per-project legacy database name is derived from the platform base URL.
  WORKFLOW_POSTGRES_URL: ["WORKFLOW_POSTGRES_URL"],
};

export const RESERVED_RUNTIME_ENVIRONMENT_KEYS: readonly string[] = Object.keys(
  RESERVED_RUNTIME_ENVIRONMENT_SOURCES,
);

/**
 * Every worker-environment variable the reserved layer reads, deduplicated and
 * ordered so a fingerprint over it is stable across worker restarts.
 */
export const RESERVED_RUNTIME_ENVIRONMENT_INPUTS: readonly string[] = [
  ...new Set(Object.values(RESERVED_RUNTIME_ENVIRONMENT_SOURCES).flat()),
].sort();
