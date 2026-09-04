import {
  externalDestinationDomains,
  type ExternalDestinationConfig,
  type ObservabilitySignal,
} from "@evelandhq/core/observability";
import { deriveAgentTelemetrySecret } from "@evelandhq/core/server/agent-telemetry-credential";
import {
  decryptDestinationConfig,
  parseObservabilityPrivateHostAllowlist,
  requestExternalObservabilityDestination,
} from "@evelandhq/core/server/observability";
import { DEFAULT_TEAM_ID, type Store } from "@evelandhq/db";
import {
  resolvePlatformOtlpServiceToken,
  runWithPlatformTracingSuppressed,
} from "@evelandhq/platform-observability";
import type { ApiApp, AppOptions } from "./app-types.js";
import { isServiceRequest } from "./app-support.js";
import { prepareExternalOtlpJson } from "./observability/egress.js";

const maxExternalOtlpRequestBytes = 16 * 1024 * 1024;
const externalOtlpContentType = "application/json";
const failureLogIntervalMs = 60_000;

/**
 * Registered alongside the other internal routes, ahead of the session-auth
 * middleware: the Collector authenticates with the OTLP service token and
 * carries no session, so a route behind that middleware would 401 before its
 * own token check ever runs.
 */
export function registerObservabilityProxyRoute(input: {
  app: ApiApp;
  store: Store;
  options: AppOptions;
  appSecretKey: string;
}): void {
  const { app, store, options, appSecretKey } = input;
  const telemetrySecret = deriveAgentTelemetrySecret(appSecretKey);
  const failureLog = createDestinationFailureLog();

  app.post("/internal/observability/destinations/:destinationId/v1/:signal", async (c) => {
    const token = options.otlpServiceToken ?? resolvePlatformOtlpServiceToken(process.env);
    if (!isServiceRequest(c.req.header("authorization"), token)) {
      return c.json({ error: "Not found" }, 404);
    }
    const signal = parseSignal(c.req.param("signal"));
    if (!signal) return c.json({ error: "Not found" }, 404);
    const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== externalOtlpContentType) {
      return c.json({ error: "OTLP/HTTP JSON is required" }, 415);
    }
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxExternalOtlpRequestBytes) {
      return c.json({ error: "OTLP request is too large" }, 413);
    }
    const receivedBody = new Uint8Array(await c.req.arrayBuffer());
    if (receivedBody.byteLength > maxExternalOtlpRequestBytes) {
      return c.json({ error: "OTLP request is too large" }, 413);
    }
    const policy = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    const destination = policy.externalDestinations.find(
      (candidate) =>
        candidate.id === c.req.param("destinationId") &&
        candidate.enabled &&
        (candidate.supportedSignals as readonly string[]).includes(signal),
    );
    if (!destination) return c.json({ error: "Not found" }, 404);
    const body = await prepareExternalOtlpJson({
      body: receivedBody,
      signal,
      store,
      telemetrySecret,
      allowedDomains: externalDestinationDomains(destination),
      environment: process.env.NODE_ENV === "production" ? "production" : "development",
    });
    if (!body) {
      return c.json({ error: "Invalid OTLP request" }, 400);
    }
    let config: ExternalDestinationConfig;
    try {
      config = decryptDestinationConfig(destination.encryptedConfig, appSecretKey);
      if (config.kind !== destination.kind) {
        throw new Error("Destination kind does not match.");
      }
      const response = await runWithPlatformTracingSuppressed(() =>
        (options.forwardExternalObservabilityRequest ?? requestExternalObservabilityDestination)({
          config,
          signal,
          contentType,
          body,
          privateHostAllowlist: parseObservabilityPrivateHostAllowlist(
            process.env.EVELAND_OBSERVABILITY_PRIVATE_ENDPOINT_ALLOWLIST,
          ),
        }),
      );
      failureLog.clear(destination.id);
      return new Response(Uint8Array.from(response.body).buffer, {
        status: response.status,
        headers: response.contentType ? { "content-type": response.contentType } : undefined,
      });
    } catch (error) {
      failureLog.record({
        destinationId: destination.id,
        kind: destination.kind,
        signal,
        error,
      });
      return c.json({ error: "External observability destination is unavailable" }, 502);
    }
  });
}

/**
 * The 502 above used to be the only trace a broken destination left in the
 * API: an unreachable endpoint, a host the allowlist rejects, and a config
 * sealed under a rotated APP_SECRET_KEY all answered the same opaque body,
 * and the reason surfaced only in the Worker's five-minute health probe.
 *
 * It has to be logged without becoming a flood. The Collector's persistent
 * queue retries a failing destination forever, so a permanent fault is a
 * permanent stream of identical failures. One line is emitted when the reason
 * changes and at most one repeat per minute, carrying how many were suppressed
 * in between. State is per app instance, not per module, so tests never see
 * each other's throttle.
 */
function createDestinationFailureLog(): {
  record: (input: {
    destinationId: string;
    kind: string;
    signal: ObservabilitySignal;
    error: unknown;
  }) => void;
  clear: (destinationId: string) => void;
} {
  const states = new Map<string, { message: string; loggedAt: number; suppressed: number }>();
  return {
    record: (input) => {
      const message = input.error instanceof Error ? input.error.message : String(input.error);
      const at = Date.now();
      const previous = states.get(input.destinationId);
      const repeated = previous !== undefined && previous.message === message;
      if (repeated && at - previous.loggedAt < failureLogIntervalMs) {
        previous.suppressed += 1;
        return;
      }
      const suppressed = previous?.suppressed ?? 0;
      states.set(input.destinationId, { message, loggedAt: at, suppressed: 0 });
      console.error(
        `Observability destination ${input.destinationId} (${input.kind}) could not forward ${
          input.signal
        }; answering 502 so the Collector keeps the batch queued: ${message}${
          suppressed > 0 ? ` (+${suppressed} suppressed since the previous line)` : ""
        }`,
      );
    },
    clear: (destinationId) => {
      states.delete(destinationId);
    },
  };
}

function parseSignal(value: string) {
  return value === "traces" || value === "logs" || value === "metrics" ? value : null;
}
