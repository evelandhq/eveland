/**
 * The environment names the platform owns at runtime, and what each one is
 * derived from, in one place.
 *
 * `composeDeploymentEnv` builds these into its `reserved` layer, which
 * `mergeRuntimeEnvironment` applies last so a project cannot redirect the
 * injected workflow world, forge its own project id, or raise its share of the
 * shared Postgres connection budget. Nothing rejects these names at write time
 * -- an operator may declare an entry called `NODE_ENV` or
 * `WORKFLOW_WORLD_URL` -- so the runtime defends itself by precedence.
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
  // Where the instance's Model Gateway is, read from the database at every
  // launch (never from worker environment). Always present, empty when the
  // project uses no gateway, so a project entry cannot aim the injected default
  // provider at a gateway of its own choosing. The key is not reserved: it is
  // the project's own AI_GATEWAY_API_KEY.
  EVELAND_MODEL_GATEWAY_KIND: [],
  EVELAND_MODEL_GATEWAY_URL: [],
  // Per project by construction; no platform input can change it.
  EVELAND_PROJECT_ID: [],
  EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES: ["EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES"],
  EVELAND_SANDBOX_MAX_OUTPUT_BYTES: ["EVELAND_SANDBOX_MAX_OUTPUT_BYTES"],
  EVELAND_SANDBOX_RUN_TIMEOUT_MS: ["EVELAND_SANDBOX_RUN_TIMEOUT_MS"],
  EVELAND_SCHEDULER_REDEEM_URL: ["EVELAND_SCHEDULER_REDEEM_URL"],
  // The same runtime secret as WORKFLOW_WORLD_RUNTIME_SECRET, under the name
  // the injected Scheduler Channel reads. The development fallback is keyed
  // off NODE_ENV, so a production flip changes the secret even when the
  // variable itself does not.
  EVELAND_SCHEDULER_RUNTIME_SECRET: ["WORKFLOW_WORLD_RUNTIME_SECRET", "NODE_ENV"],
  // Tenancy, topology, and dispatch authentication for the platform workflow
  // world. A project that could set these could scope its world at another
  // tenant's data, hand the runner a database nothing provisions, or make every
  // dispatch fail authentication; a spec version would ask the World for a
  // storage generation it refuses. ./reserved-environment.test.ts fails on any
  // name the installed World reads that is in neither this table nor
  // DEPLOYMENT_LAUNCH_ENVIRONMENT_KEYS.
  WORKFLOW_SPEC_VERSION: [],
  // eve starts the URLs it hands out to be called back on -- connection
  // sign-in links and remote-agent callbacks -- from this origin, and falls
  // back to the loopback address the process serves on.
  // The platform sets it to the project's public Agent origin; a project that
  // could set it would send those callbacks somewhere else.
  WORKFLOW_LOCAL_BASE_URL: [
    "EVELAND_AGENT_BASE_DOMAINS",
    "EVELAND_GATEWAY_PUBLIC_SCHEME",
    "EVELAND_GATEWAY_PUBLIC_PORT",
  ],
  WORKFLOW_WORLD_RUNTIME_SECRET: ["WORKFLOW_WORLD_RUNTIME_SECRET", "NODE_ENV"],
  WORKFLOW_WORLD_STREAM_COMPACTION: ["WORKFLOW_WORLD_STREAM_COMPACTION"],
  // Per project by construction, like EVELAND_PROJECT_ID.
  WORKFLOW_WORLD_TENANT_ID: [],
  WORKFLOW_WORLD_URL: ["WORKFLOW_WORLD_URL"],
  // eve 0.52.0 turned on CLI telemetry by default: every `eve build`,
  // `eve info`, and `eve start` the platform runs would otherwise spawn a
  // detached flush that POSTs command usage to telemetry.vercel.com and, on a
  // systemd build where HOME is the release directory, write its installation
  // identity into the Release itself. The platform owns the decision for the
  // processes it runs, so the value is a constant with no platform input, and
  // it is reserved so a project entry cannot re-enable it. The same constant
  // rides the build environment (systemd) and the image (Docker).
  EVE_TELEMETRY_DISABLED: [],
  // The platform scheduler dispatches every authored schedule through the
  // injected Scheduler Channel; eve's own cron runner would fire each one a
  // second time, on every running Deployment of the project. A constant, and
  // reserved so a project entry cannot turn eve's runner back on.
  EVE_SCHEDULES_DISABLED: [],
  // Reserved at runtime only in production, but reserved for every build
  // regardless: `npm ci` and `pnpm install --frozen-lockfile` both omit
  // devDependencies when NODE_ENV=production is in the environment, so an entry
  // carrying it would strip the project's own build toolchain out of the
  // install that `npx eve build` then runs against.
  NODE_ENV: ["NODE_ENV"],
  // Read by the World: connection capacity on the workflow Postgres instance
  // is platform-planned (max_connections ~ pool size x running Deployments).
  WORKFLOW_POSTGRES_MAX_POOL_SIZE: ["WORKFLOW_POSTGRES_MAX_POOL_SIZE"],
};

export const RESERVED_RUNTIME_ENVIRONMENT_KEYS: readonly string[] = Object.keys(
  RESERVED_RUNTIME_ENVIRONMENT_SOURCES,
);

/**
 * Names the platform sets per Deployment when it launches a process, after the
 * reserved layer: every one carries that Deployment's id. They are not in the
 * reserved table because composeDeploymentEnv runs per project, not per
 * Deployment; ../jobs/deployment-launch-context.ts writes them last.
 */
export const DEPLOYMENT_LAUNCH_ENVIRONMENT_KEYS: readonly string[] = [
  "EVELAND_DEPLOYMENT_ID",
  // The same id under the name the shared World reads.
  "WORKFLOW_WORLD_DEPLOYMENT_ID",
];

/**
 * Every worker-environment variable the reserved layer reads, deduplicated and
 * ordered so a fingerprint over it is stable across worker restarts.
 */
export const RESERVED_RUNTIME_ENVIRONMENT_INPUTS: readonly string[] = [
  ...new Set(Object.values(RESERVED_RUNTIME_ENVIRONMENT_SOURCES).flat()),
].sort();
