export type EvelandComponent = "web" | "api" | "gateway" | "worker";

export type ConfigurationEntry = {
  name: string;
  value: string;
  source: "environment" | "default" | "derived" | "not_configured";
  sensitivity: "public" | "secret" | "url";
  purpose: string;
  status: "ok" | "warning" | "missing";
};

export type ConfigurationSnapshot = {
  component: EvelandComponent;
  observedAt: string;
  entries: ConfigurationEntry[];
};

export type UnavailableConfigurationSnapshot = {
  component: EvelandComponent;
  observedAt: null;
  entries: [];
  unavailableReason: string;
};

export type SystemConfigurationDiagnostics = {
  components: Array<ConfigurationSnapshot | UnavailableConfigurationSnapshot>;
};

type Environment = Record<string, string | undefined>;
type ResolvedValue = { value: string; source: "default" | "derived" };
type ValueResolver = (env: Environment, component: EvelandComponent) => ResolvedValue | undefined;

type ConfigurationDefinition = {
  name: string;
  components: EvelandComponent[];
  sensitivity?: ConfigurationEntry["sensitivity"];
  purpose: string;
  fallback?: string | ValueResolver;
  required?: boolean | ((env: Environment, component: EvelandComponent) => boolean);
  warning?: (env: Environment, value: string, source: ConfigurationEntry["source"]) => boolean;
  emptyUsesFallback?: boolean;
};

const production = (env: Environment) => env.NODE_ENV === "production";
const defaultValue = (value: string): ResolvedValue => ({ value, source: "default" });
const derivedValue = (value: string): ResolvedValue => ({ value, source: "derived" });
const developmentSecret = (env: Environment): ResolvedValue | undefined =>
  production(env) ? undefined : defaultValue("development fallback");
const productionSecretWarning = (env: Environment, _value: string, source: ConfigurationEntry["source"]) =>
  !production(env) && source === "default";
const allComponents: EvelandComponent[] = ["web", "api", "gateway", "worker"];

const definitions: ConfigurationDefinition[] = [
  { ...entry("NODE_ENV", allComponents, "Controls production-only validation and runtime defaults.", "development"), emptyUsesFallback: true },
  { ...entry("EVELAND_RELEASE_CHANNEL", allComponents, "Labels this Eveland build as dev, edge, prerelease, or stable.", "dev"), emptyUsesFallback: true },
  {
    ...entry("EVELAND_REVISION", allComponents, "Identifies the exact Git revision running this component.", "unknown"),
    warning: (_env, value) => value === "unknown",
    emptyUsesFallback: true,
  },
  {
    name: "DATABASE_URL",
    components: ["api", "gateway", "worker"],
    sensitivity: "url",
    purpose: "Connects the component to the Eveland Postgres database.",
    required: true,
  },
  entry("DATABASE_POOL_SIZE", ["api", "gateway", "worker"], "Limits Postgres connections opened by this process.", "10"),
  {
    name: "APP_SECRET_KEY",
    components: ["api", "worker"],
    sensitivity: "secret",
    purpose: "Encrypts and decrypts stored Project Secrets; API and Worker values must match.",
    fallback: developmentSecret,
    required: production,
    warning: productionSecretWarning,
  },
  {
    name: "EVELAND_GATEWAY_SERVICE_TOKEN",
    components: ["api", "gateway"],
    sensitivity: "secret",
    purpose: "Authenticates API and Gateway calls across their privileged /internal routes.",
    fallback: developmentSecret,
    required: production,
    warning: productionSecretWarning,
  },
  {
    name: "EVELAND_GATEWAY_SERVICE_TOKEN",
    components: ["worker"],
    sensitivity: "secret",
    purpose: "Authenticates Worker route-cache invalidation requests to Gateway.",
    required: production,
  },
  {
    name: "API_URL",
    components: ["web"],
    sensitivity: "url",
    purpose: "Server-side API origin used by the Web process.",
    fallback: (env) => derivedValue(env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"),
  },
  urlEntry("NEXT_PUBLIC_API_URL", ["web"], "Browser-visible control-plane API origin.", "http://localhost:4000"),
  entry("PORT", ["api"], "TCP port used by the control-plane API.", "4000"),
  { ...urlEntry("WEB_ORIGIN", ["api"], "Allowed browser origin for authenticated control-plane CORS.", "http://localhost:3000"), emptyUsesFallback: true },
  {
    name: "BETTER_AUTH_SECRET",
    components: ["api"],
    sensitivity: "secret",
    purpose: "Signs and encrypts Better Auth sessions; independent from application and Gateway secrets.",
    required: true,
  },
  {
    name: "BETTER_AUTH_URL",
    components: ["api"],
    sensitivity: "url",
    purpose: "Browser-visible API origin used by Better Auth.",
    fallback: (env) => derivedValue(`http://localhost:${env.PORT ?? "4000"}`),
    emptyUsesFallback: true,
  },
  { ...entry("EVELAND_ADMIN_EMAIL", ["api"], "Email address of the default bootstrapped administrator.", "admin@example.com"), emptyUsesFallback: true },
  { ...entry("EVELAND_ADMIN_NAME", ["api"], "Display name of the default bootstrapped administrator.", "Admin"), emptyUsesFallback: true },
  {
    name: "EVELAND_ADMIN_PASSWORD",
    components: ["api"],
    sensitivity: "secret",
    purpose: "Initial password used to bootstrap the default administrator.",
    required: true,
  },
  { ...entry("EVELAND_COOKIE_DOMAIN", ["api"], "Optional shared parent domain for the control-plane session cookie."), emptyUsesFallback: true },
  urlEntry(
    "EVELAND_IDENTITY_ISSUER",
    ["api", "worker"],
    "Stable public issuer for Agent-user Caller Tokens.",
    "http://localhost:4000",
  ),
  {
    ...entry(
      "EVELAND_IDENTITY_ALLOWED_ORIGINS",
      ["api"],
      "Comma-separated exact browser origins allowed to use the Identity API.",
      "http://localhost:3010",
    ),
    required: production,
  },
  {
    ...urlEntry(
      "EVELAND_IDENTITY_JWKS_URL",
      ["worker"],
      "Agent-reachable JWKS URL injected into deployed runtimes.",
      "http://host.docker.internal:4000/.well-known/jwks.json",
    ),
    required: production,
  },
  entry("EVELAND_DATA_DIR", ["api", "worker"], "Root for managed sources, releases, and runtime state.", ".eveland-data"),
  {
    name: "EVELAND_HOST_DATA_DIR",
    components: ["worker"],
    purpose: "Host-daemon view of EVELAND_DATA_DIR for a containerized Docker worker.",
    fallback: (env) => derivedValue(env.EVELAND_DATA_DIR ?? ".eveland-data"),
  },
  entry("EVELAND_OTLP_ENDPOINT", ["api", "gateway", "worker"], "Internal OTLP/HTTP endpoint used by Eveland platform telemetry.", "http://127.0.0.1:4318"),
  {
    name: "EVELAND_OTLP_SERVICE_TOKEN",
    components: ["api"],
    sensitivity: "secret",
    purpose: "Authenticates the managed Collector to Built-in OTLP ingest.",
    required: production,
  },
  entry("EVELAND_OTEL_METRIC_INTERVAL_MS", ["api", "gateway", "worker"], "Platform metric export interval in milliseconds.", "60000"),
  entry("EVELAND_RELEASE_RETENTION", ["api", "worker"], "Minimum number of newest Release artifacts protected from archival.", "3"),
  entry("EVELAND_RELEASE_SWEEP_INTERVAL_MS", ["worker"], "Interval between automatic Release retention sweeps.", "3600000"),
  entry("EVELAND_RELEASE_SWEEP_BATCH_SIZE", ["worker"], "Maximum archive jobs enqueued by one Release retention sweep.", "25"),
  { ...entry("EVELAND_GATEWAY_PUBLIC_SCHEME", ["api", "gateway"], "Public Agent URL scheme and affinity-cookie security mode.", "http"), emptyUsesFallback: true },
  {
    name: "EVELAND_GATEWAY_PUBLIC_PORT",
    components: ["api"],
    purpose: "Optional public Agent port appended to generated endpoints.",
    fallback: (env) => derivedValue((env.EVELAND_GATEWAY_PUBLIC_SCHEME || "http") === "http" ? "4080" : "0"),
  },
  urlEntry("EVELAND_GATEWAY_INTERNAL_URL", ["api"], "Private Gateway origin used for Playground and diagnostics.", "http://127.0.0.1:4080"),
  {
    ...urlEntry("EVELAND_GATEWAY_INTERNAL_URL", ["worker"], "Private Gateway origin used for route-cache invalidation."),
    required: production,
  },
  entry("EVELAND_AGENT_BASE_DOMAINS", ["api", "gateway", "worker"], "Allowed Agent hostname suffixes; the first is canonical.", "agent.localhost"),
  entry("GATEWAY_PORT", ["gateway"], "TCP port used by the public Agent Gateway.", "4080"),
  {
    name: "EVELAND_GATEWAY_AFFINITY_SECRET",
    components: ["gateway"],
    sensitivity: "secret",
    purpose: "Signs the Agent affinity cookie; independent from the internal service token.",
    fallback: developmentSecret,
    required: production,
    warning: productionSecretWarning,
  },
  entry("EVELAND_GATEWAY_MAX_REQUEST_BODY_BYTES", ["gateway"], "Maximum buffered public request body accepted by Gateway.", "10485760"),
  entry("EVELAND_PLAYGROUND_TIMEOUT_MS", ["gateway"], "Timeout for privileged Playground requests proxied to a Deployment.", "120000"),
  urlEntry("EVELAND_API_INTERNAL_URL", ["gateway"], "Private API origin used for service-authenticated runtime activation.", "http://127.0.0.1:4000"),
  entry("EVELAND_ACTIVATION_LEASE_TTL_MS", ["api"], "Lifetime of request, stream, turn, and ScheduleRun activation leases.", "180000"),
  entry(
    "EVELAND_PLAYGROUND_SESSION_IDLE_TTL_MS",
    ["api", "gateway", "worker"],
    "Idle time after the last successful Playground session request before its Deployment binding expires.",
    "86400000",
  ),
  entry(
    "EVELAND_API_SESSION_IDLE_TTL_MS",
    ["api", "gateway", "worker"],
    "Idle time after the last successful public API session request before its Deployment binding expires.",
    "604800000",
  ),
  entry("EVELAND_COLD_START_TIMEOUT_MS", ["api"], "Maximum time Gateway may wait for a dormant Deployment to become ready.", "30000"),
  entry("EVELAND_SOURCE_PREFLIGHT_TTL_MS", ["api"], "Lifetime of an unconsumed validated source snapshot.", "3600000"),
  entry("EVELAND_ACTIVATION_RENEW_INTERVAL_MS", ["gateway"], "Interval for renewing a lease while an upstream response stream remains active.", "60000"),
  {
    name: "EVELAND_SCHEDULER_RUNTIME_SECRET",
    components: ["api", "worker"],
    sensitivity: "secret",
    purpose: "Authenticates the private injected Scheduler Channel and its API callback.",
    fallback: developmentSecret,
    required: production,
    warning: productionSecretWarning,
  },
  {
    name: "EVELAND_SCHEDULER_DISPATCH_SECRET",
    components: ["api", "worker"],
    sensitivity: "secret",
    purpose: "Signs short-lived Deployment- and ScheduleRun-bound dispatch credentials.",
    fallback: developmentSecret,
    required: production,
    warning: productionSecretWarning,
  },
  {
    ...urlEntry(
      "EVELAND_SCHEDULER_REDEEM_URL",
      ["worker"],
      "API callback used by the injected Scheduler Channel to claim and complete dispatches.",
    ),
    required: true,
  },
  entry("EVELAND_SCHEDULER_PLANNER_BATCH_SIZE", ["worker"], "Maximum due schedules claimed in one planner tick.", "25"),
  entry("EVELAND_SCHEDULER_DISPATCH_TIMEOUT_MS", ["worker"], "Maximum private Scheduler Channel dispatch duration.", "120000"),
  {
    name: "WORKFLOW_POSTGRES_URL",
    components: ["worker"],
    sensitivity: "url",
    purpose: "Platform-owned durable workflow database URL injected into every Deployment.",
    required: production,
  },
  {
    name: "WORKFLOW_POSTGRES_BOOTSTRAP_URL",
    components: ["worker"],
    sensitivity: "url",
    purpose: "Worker-reachable URL used to bootstrap the durable workflow database.",
    fallback: (env) => resolveWorkflowBootstrapUrl(env),
  },
  {
    name: "EVELAND_RUNTIME",
    components: ["worker"],
    purpose: "Selects the Docker or systemd Deployment runtime.",
    fallback: (env) => derivedValue(production(env) ? "systemd" : "docker"),
    emptyUsesFallback: true,
  },
  entry("EVELAND_APP_USER", ["worker"], "Unix account used to run systemd Agent Deployments.", "eveland-app"),
  entry("EVELAND_BUILD_USER", ["worker"], "Unprivileged Unix account used for Project builds.", "eveland-build"),
  {
    ...entry("EVELAND_BUILD_SANDBOX", ["worker"], "Build isolation backend; none disables lifecycle-script sandboxing.", "bwrap"),
    warning: (_env, value) => value === "none",
    emptyUsesFallback: true,
  },
  entry("EVELAND_MEMORY_MAX", ["worker"], "systemd MemoryMax limit applied per Deployment.", "2G"),
  entry("EVELAND_CPU_QUOTA", ["worker"], "systemd CPUQuota limit applied per Deployment.", "200%"),
  entry("EVELAND_INTERNAL_PORT", ["worker"], "Container-internal port used by Docker Deployments.", "3000"),
  entry("EVELAND_DEPLOYMENT_PORT", ["worker"], "Start of the private host-port allocation range.", "41000"),
  entry("EVELAND_GIT_CLONE_TIMEOUT_MS", ["worker"], "Maximum duration of a non-interactive Git source clone.", "120000"),
  entry("EVELAND_GIT_CLONE_MAX_ATTEMPTS", ["worker"], "Maximum attempts for transient Git clone failures.", "3"),
  entry("EVELAND_GIT_CLONE_RETRY_DELAY_MS", ["worker"], "Initial exponential backoff delay for Git clone retries.", "1000"),
  entry("EVELAND_HEALTH_TIMEOUT_MS", ["worker"], "Time allowed for a Deployment to become healthy.", "15000"),
  entry("EVELAND_HOST_METRIC_INTERVAL_MS", ["worker"], "Cadence for standard host CPU, memory, filesystem, workload, and heartbeat metrics.", "60000"),
  entry("EVELAND_OTEL_COLLECTOR_CONTAINER", ["worker"], "Managed Collector container reloaded after a validated settings revision.", "eveland-otel-collector"),
  entry("EVELAND_OTEL_COLLECTOR_IMAGE", ["worker"], "Official Collector image used to validate generated configuration.", "otel/opentelemetry-collector-contrib:0.149.0"),
  entry("EVELAND_SCHEDULER_PREWARM_MS", ["worker"], "How far before nextRunAt a scheduler target is kept warm or proactively activated.", "60000"),
  entry("EVELAND_SCHEDULE_RUN_MAX_RUNTIME_MS", ["worker"], "Hard deadline for a dispatched ScheduleRun when no Observer execution boundary arrives.", "86400000"),
  entry("EVELAND_ACTIVATION_IDLE_TTL_MS", ["worker"], "Idle time after the final lease before a ready RuntimeInstance is stopped.", "300000"),
  entry("EVELAND_ACTIVATION_REAPER_BATCH_SIZE", ["worker"], "Maximum idle RuntimeInstances claimed in one reaper tick.", "25"),
  entry("EVELAND_ACTIVATION_RECOVERY_BATCH_SIZE", ["worker"], "Maximum starting RuntimeInstances recovered in one worker tick.", "25"),
  entry("EVELAND_ACTIVATION_START_STALE_MS", ["worker"], "Age after which a running activation job may be reclaimed after a crash.", "300000"),
  entry("EVELAND_ACTIVATION_RECONCILE_BATCH_SIZE", ["worker"], "Maximum ready RuntimeInstances checked against their owning runtime per tick.", "100"),
  {
    name: "EVELAND_SANDBOX_CACHE_DIR",
    components: ["worker"],
    purpose: "Durable per-Project Eve sandbox workspace root.",
    fallback: (env) => derivedValue(joinPath(env.EVELAND_DATA_DIR ?? ".eveland-data", "sandbox")),
  },
  entry("WORKER_POLL_INTERVAL_MS", ["worker"], "Delay between Worker job-queue polling attempts.", "5000"),
  entry("WORKER_JOB_HEARTBEAT_INTERVAL_MS", ["worker"], "Interval used to renew a running job lease.", "30000"),
  entry("WORKER_JOB_STALE_MS", ["worker"], "Age after which a running job without a heartbeat is recovered.", "120000"),
  entry("WORKER_JOB_RECOVERY_BATCH_SIZE", ["worker"], "Maximum stale jobs recovered in one worker tick.", "25"),
  {
    name: "WORKER_ID",
    components: ["worker"],
    purpose: "Stable identity used for job claims, heartbeat, and host metric history.",
    fallback: () => derivedValue("worker-<pid>"),
  },
];

export function createConfigurationSnapshot(
  component: EvelandComponent,
  env: Environment,
  observedAt = new Date(),
): ConfigurationSnapshot {
  const entries = definitions
    .filter((definition) => definition.components.includes(component))
    .map((definition) => resolveEntry(definition, component, env))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { component, observedAt: observedAt.toISOString(), entries };
}

function resolveEntry(
  definition: ConfigurationDefinition,
  component: EvelandComponent,
  env: Environment,
): ConfigurationEntry {
  const raw = env[definition.name];
  const explicitlyEmpty = raw !== undefined && raw.trim() === "";
  const configured = explicitlyEmpty && definition.emptyUsesFallback ? undefined : raw;
  const fallback = configured !== undefined ? undefined : resolveFallback(definition.fallback, env, component);
  const effective = configured ?? fallback?.value;
  const source: ConfigurationEntry["source"] =
    configured !== undefined ? "environment" : fallback?.source ?? "not_configured";
  const required =
    typeof definition.required === "function" ? definition.required(env, component) : (definition.required ?? false);
  const sensitivity = definition.sensitivity ?? "public";
  const status =
    effective === undefined
      ? required ? "missing" : "ok"
      : effective === ""
        ? required || sensitivity === "secret" ? "missing" : "warning"
        : definition.warning?.(env, effective, source) ? "warning" : "ok";

  return {
    name: definition.name,
    value:
      effective === undefined || (effective === "" && sensitivity === "secret")
        ? "Not configured"
        : effective === ""
          ? "Empty string"
          : displayValue(effective, sensitivity),
    source,
    sensitivity,
    purpose: definition.purpose,
    status,
  };
}

function resolveFallback(
  fallback: ConfigurationDefinition["fallback"],
  env: Environment,
  component: EvelandComponent,
): ResolvedValue | undefined {
  if (typeof fallback === "function") return fallback(env, component);
  return fallback === undefined ? undefined : defaultValue(fallback);
}

function displayValue(value: string, sensitivity: ConfigurationEntry["sensitivity"]): string {
  if (sensitivity === "secret") return "••••••••";
  if (sensitivity !== "url") return value;
  try {
    const parsed = new URL(value);
    const authority = parsed.username || parsed.password ? `••••@${parsed.host}` : parsed.host;
    const query = [...parsed.searchParams.keys()].map((key) => `${encodeURIComponent(key)}=••••`).join("&");
    return `${parsed.protocol}//${authority}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return "Configured (invalid URL)";
  }
}

function resolveWorkflowBootstrapUrl(env: Environment): ResolvedValue | undefined {
  const workflowUrl = nonEmpty(env.WORKFLOW_POSTGRES_URL);
  if (!workflowUrl) return undefined;
  const databaseUrl = nonEmpty(env.DATABASE_URL);
  if (databaseUrl && isHostDatabaseAlias(workflowUrl, databaseUrl)) return derivedValue(databaseUrl);
  return derivedValue(workflowUrl);
}

function isHostDatabaseAlias(workflowUrl: string, databaseUrl: string): boolean {
  try {
    const workflow = new URL(workflowUrl);
    const database = new URL(databaseUrl);
    const port = (url: URL) => url.port || "5432";
    return (
      workflow.hostname.toLowerCase() === "host.docker.internal" &&
      workflow.protocol === database.protocol &&
      workflow.username === database.username &&
      workflow.password === database.password &&
      port(workflow) === port(database) &&
      workflow.pathname === database.pathname &&
      workflow.search === database.search
    );
  } catch {
    return false;
  }
}

function entry(
  name: string,
  components: EvelandComponent[],
  purpose: string,
  fallback?: string,
): ConfigurationDefinition {
  return { name, components, purpose, fallback };
}

function urlEntry(
  name: string,
  components: EvelandComponent[],
  purpose: string,
  fallback?: string,
): ConfigurationDefinition {
  return { name, components, purpose, fallback, sensitivity: "url" };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function joinPath(root: string, child: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return normalizedRoot ? `${normalizedRoot}/${child}` : child;
}
