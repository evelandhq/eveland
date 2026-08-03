import { once } from "node:events";
import { createServer, request, type IncomingMessage } from "node:http";
import { SpanKind } from "@opentelemetry/api";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startPlatformObservability } from "./index.js";

const traceExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const telemetry = startPlatformObservability({
  serviceName: "eveland-api",
  serviceInstanceId: "esm-http-test",
  environment: "test",
  teamId: "team_local",
  otlpEndpoint: "http://127.0.0.1:4318",
  otlpServiceToken: "platform-service-token",
  metricExportIntervalMs: 600_000,
  ignoredIncomingPaths: ["/internal/otel/"],
  exporters: {
    traces: traceExporter,
    logs: new InMemoryLogRecordExporter(),
    metrics: metricExporter,
  },
});

const server = createServer((_incoming, response) => {
  response.end("ok");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("HTTP test server did not expose a TCP address.");
}

await sendRequest(address.port, "/probe");
await sendRequest(address.port, "/internal/otel/v1/traces");
await telemetry.forceFlush();

const serverSpans = traceExporter
  .getFinishedSpans()
  .filter((span) => span.kind === SpanKind.SERVER)
  .map((span) => ({
    scope: span.instrumentationScope.name,
    path: span.attributes["url.path"],
  }));
const exportedMetrics = metricExporter.getMetrics();
const serverDurationResource = exportedMetrics.find((data) =>
  data.scopeMetrics.some((scope) =>
    scope.metrics.some((metric) => metric.descriptor.name === "http.server.request.duration"),
  ),
);
const serverDuration = exportedMetrics
  .flatMap((data) => data.scopeMetrics)
  .flatMap((scope) => scope.metrics)
  .find((metric) => metric.descriptor.name === "http.server.request.duration");

process.stdout.write(
  JSON.stringify({
    serverSpans,
    serverDuration: serverDuration
      ? {
          serviceName: serverDurationResource?.resource.attributes["service.name"],
          unit: serverDuration.descriptor.unit,
          attributes: serverDuration.dataPoints.map((point) => point.attributes),
        }
      : null,
  }),
);

server.close();
await once(server, "close");
await telemetry.shutdown();

function sendRequest(port: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method: "GET" }, (response) =>
      drainResponse(response, resolve),
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function drainResponse(response: IncomingMessage, resolve: () => void): void {
  response.resume();
  response.on("end", resolve);
}
