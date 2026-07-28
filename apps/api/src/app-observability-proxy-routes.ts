import type { ExternalDestinationConfig } from "@eveland/core/observability";
import { deriveAgentTelemetrySecret } from "@eveland/core/server/agent-telemetry-credential";
import {
  decryptDestinationConfig,
  parseObservabilityPrivateHostAllowlist,
  requestExternalObservabilityDestination,
} from "@eveland/core/server/observability";
import { DEFAULT_TEAM_ID, type Store } from "@eveland/db";
import { runWithPlatformTracingSuppressed } from "@eveland/platform-observability";
import type { ApiApp, AppOptions } from "./app-types.js";
import { isServiceRequest } from "./app-support.js";
import { prepareExternalOtlpJson } from "./observability/egress.js";

const maxExternalOtlpRequestBytes = 16 * 1024 * 1024;
const externalOtlpContentType = "application/json";

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

  app.post(
    "/internal/observability/destinations/:destinationId/v1/:signal",
    async (c) => {
      const token =
        options.otlpServiceToken ?? process.env.EVELAND_OTLP_SERVICE_TOKEN;
      if (!isServiceRequest(c.req.header("authorization"), token)) {
        return c.json({ error: "Not found" }, 404);
      }
      const signal = parseSignal(c.req.param("signal"));
      if (!signal) return c.json({ error: "Not found" }, 404);
      const contentType = c.req
        .header("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== externalOtlpContentType) {
        return c.json({ error: "OTLP/HTTP JSON is required" }, 415);
      }
      const contentLength = Number(c.req.header("content-length") ?? 0);
      if (
        Number.isFinite(contentLength) &&
        contentLength > maxExternalOtlpRequestBytes
      ) {
        return c.json({ error: "OTLP request is too large" }, 413);
      }
      const receivedBody = new Uint8Array(await c.req.arrayBuffer());
      if (receivedBody.byteLength > maxExternalOtlpRequestBytes) {
        return c.json({ error: "OTLP request is too large" }, 413);
      }
      const body = await prepareExternalOtlpJson({
        body: receivedBody,
        signal,
        store,
        telemetrySecret,
        environment:
          process.env.NODE_ENV === "production"
            ? "production"
            : "development",
      });
      if (!body) {
        return c.json({ error: "Invalid OTLP request" }, 400);
      }
      const policy = await store.getObservabilityPolicy(DEFAULT_TEAM_ID);
      const destination = policy.externalDestinations.find(
        (candidate) =>
          candidate.id === c.req.param("destinationId") &&
          candidate.enabled &&
          (candidate.supportedSignals as readonly string[]).includes(signal),
      );
      if (!destination) return c.json({ error: "Not found" }, 404);
      let config: ExternalDestinationConfig;
      try {
        config = decryptDestinationConfig(
          destination.encryptedConfig,
          appSecretKey,
        );
        if (config.kind !== destination.kind) {
          throw new Error("Destination kind does not match.");
        }
        const response = await runWithPlatformTracingSuppressed(() =>
          (
            options.forwardExternalObservabilityRequest ??
            requestExternalObservabilityDestination
          )({
            config,
            signal,
            contentType,
            body,
            privateHostAllowlist:
              parseObservabilityPrivateHostAllowlist(
                process.env
                  .EVELAND_OBSERVABILITY_PRIVATE_ENDPOINT_ALLOWLIST,
              ),
          }),
        );
        return new Response(Uint8Array.from(response.body).buffer, {
          status: response.status,
          headers: response.contentType
            ? { "content-type": response.contentType }
            : undefined,
        });
      } catch {
        return c.json(
          { error: "External observability destination is unavailable" },
          502,
        );
      }
    },
  );
}

function parseSignal(value: string) {
  return value === "traces" || value === "logs" || value === "metrics"
    ? value
    : null;
}
