import { resolveSecretWithDevFallback } from "@evelandhq/core/server/dev-secrets";
import {
  createConfigurationSnapshot,
  type ConfigurationSnapshot,
  type SystemConfigurationDiagnostics,
  type UnavailableConfigurationSnapshot,
} from "@evelandhq/core/config-diagnostics";
import { readConfigurationSnapshotFile } from "@evelandhq/core/server/config-diagnostics";

type Environment = Record<string, string | undefined>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type DiagnosticsDependencies = {
  fetch?: Fetch;
  observedAt?: Date;
};

export async function collectSystemConfigurationDiagnostics(
  env: Environment,
  dependencies: DiagnosticsDependencies = {},
): Promise<SystemConfigurationDiagnostics> {
  const observedAt = dependencies.observedAt ?? new Date();
  const api = createConfigurationSnapshot("api", env, observedAt);
  const [gateway, worker] = await Promise.all([
    readGatewaySnapshot(env, dependencies.fetch ?? fetch),
    readWorkerSnapshot(env.EVELAND_DATA_DIR ?? ".eveland-data"),
  ]);
  return { components: [api, gateway, worker] };
}

async function readGatewaySnapshot(env: Environment, fetchDiagnostics: Fetch) {
  const gatewayUrl = (env.EVELAND_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:4080").replace(
    /\/$/,
    "",
  );
  const serviceToken = resolveSecretWithDevFallback(
    env,
    env.EVELAND_GATEWAY_SERVICE_TOKEN,
    "eveland-dev-gateway-token",
  );
  if (!serviceToken)
    return unavailable("gateway", "Gateway diagnostics credentials are not configured.");

  try {
    const response = await fetchDiagnostics(`${gatewayUrl}/internal/diagnostics/config`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return unavailable("gateway", "Gateway diagnostics are unavailable.");
    const snapshot = (await response.json()) as unknown;
    return isSnapshot(snapshot, "gateway")
      ? snapshot
      : unavailable("gateway", "Gateway returned invalid diagnostics.");
  } catch {
    return unavailable("gateway", "Gateway diagnostics are unavailable.");
  }
}

async function readWorkerSnapshot(dataDir: string) {
  try {
    return (
      (await readConfigurationSnapshotFile(dataDir, "worker")) ??
      unavailable("worker", "Worker has not published a configuration snapshot yet.")
    );
  } catch {
    return unavailable("worker", "Worker configuration snapshot is unreadable.");
  }
}

function unavailable(
  component: UnavailableConfigurationSnapshot["component"],
  unavailableReason: string,
): UnavailableConfigurationSnapshot {
  return { component, observedAt: null, entries: [], unavailableReason };
}

function isSnapshot(
  value: unknown,
  component: ConfigurationSnapshot["component"],
): value is ConfigurationSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConfigurationSnapshot>;
  return (
    candidate.component === component &&
    typeof candidate.observedAt === "string" &&
    Array.isArray(candidate.entries)
  );
}
