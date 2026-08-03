import { context, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { isTracingSuppressed } from "@opentelemetry/core";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test } from "vitest";
import {
  createPlatformResource,
  resolvePlatformOtlpServiceToken,
  resolveOtlpHttpSignalUrls,
  runWithPlatformTracingSuppressed,
  startPrivateLogs,
  startPrivateMetrics,
  startPlatformObservability,
} from "./index.js";

afterEach(() => {
  trace.disable();
  logs.disable();
  metrics.disable();
});

describe("platform observability", () => {
  test("fails fast without the platform receiver token in production", () => {
    expect(() => resolvePlatformOtlpServiceToken({ NODE_ENV: "production" })).toThrow(
      "EVELAND_OTLP_SERVICE_TOKEN is required in production.",
    );
    expect(resolvePlatformOtlpServiceToken({ NODE_ENV: "development" })).toBe(
      "eveland-dev-otlp-service-token",
    );
  });

  test("builds credential-free standard OTLP/HTTP signal endpoints", () => {
    expect(resolveOtlpHttpSignalUrls("http://collector.internal:4318/")).toEqual({
      traces: "http://collector.internal:4318/v1/traces",
      logs: "http://collector.internal:4318/v1/logs",
      metrics: "http://collector.internal:4318/v1/metrics",
    });
    expect(() =>
      resolveOtlpHttpSignalUrls("http://eveland:secret@collector.internal:4318"),
    ).toThrow(/credentials/);
  });

  test("uses one platform Resource for traces, logs, and metrics", async () => {
    const traceExporter = new InMemorySpanExporter();
    const logExporter = new InMemoryLogRecordExporter();
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = startPlatformObservability({
      serviceName: "eveland-worker",
      serviceVersion: "0.11.0",
      serviceInstanceId: "worker-1",
      environment: "production",
      teamId: "team_local",
      otlpEndpoint: "http://127.0.0.1:4318",
      otlpServiceToken: "platform-service-token",
      exporters: {
        traces: traceExporter,
        logs: logExporter,
        metrics: metricExporter,
      },
      instrumentations: [],
    });
    expect(isTracingSuppressed(context.active())).toBe(false);
    expect(runWithPlatformTracingSuppressed(() => isTracingSuppressed(context.active()))).toBe(
      true,
    );
    expect(isTracingSuppressed(context.active())).toBe(false);

    const span = telemetry.tracer.startSpan("worker.tick");
    span.end();
    telemetry.emitLog({
      severity: "info",
      eventName: "worker.ready",
      body: "Worker ready.",
    });
    telemetry.meter.createCounter("eveland.worker.ticks").add(1);
    await telemetry.forceFlush();

    expect(traceExporter.getFinishedSpans()).toHaveLength(1);
    expect(traceExporter.getFinishedSpans()[0]?.resource.attributes).toMatchObject({
      "service.name": "eveland-worker",
      "service.version": "0.11.0",
      "service.instance.id": "worker-1",
      "deployment.environment.name": "production",
      "eveland.team.id": "team_local",
      "eveland.telemetry.domain": "platform",
    });
    expect(logExporter.getFinishedLogRecords()).toHaveLength(1);
    expect(
      metricExporter
        .getMetrics()
        .flatMap((data) => data.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .map((metric) => metric.descriptor.name),
    ).toContain("eveland.worker.ticks");
    await telemetry.shutdown();
  });

  test("constructs the same attributes without starting global providers", () => {
    expect(
      createPlatformResource({
        serviceName: "eveland-api",
        serviceInstanceId: "api-1",
        environment: "development",
        teamId: "team_local",
      }).attributes,
    ).toMatchObject({
      "service.name": "eveland-api",
      "service.instance.id": "api-1",
      "deployment.environment.name": "development",
      "eveland.telemetry.domain": "platform",
    });
  });

  test("exports capacity metrics through a private non-global provider", async () => {
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = startPrivateMetrics({
      serviceName: "eveland-worker",
      serviceVersion: "0.11.0",
      serviceInstanceId: "worker-1",
      environment: "production",
      teamId: "team_local",
      telemetryDomain: "capacity",
      otlpEndpoint: "http://127.0.0.1:4318",
      otlpServiceToken: "platform-service-token",
      exporter: metricExporter,
    });

    telemetry.meter.createCounter("eveland.worker.heartbeat").add(1);
    await telemetry.forceFlush();

    const resourceMetrics = metricExporter.getMetrics();
    expect(resourceMetrics).toHaveLength(1);
    expect(resourceMetrics[0]?.resource.attributes).toMatchObject({
      "service.name": "eveland-worker",
      "service.version": "0.11.0",
      "service.instance.id": "worker-1",
      "deployment.environment.name": "production",
      "eveland.team.id": "team_local",
      "eveland.telemetry.domain": "capacity",
    });
    await telemetry.shutdown();
  });

  test("exports runtime logs through a private non-global provider", async () => {
    const logExporter = new InMemoryLogRecordExporter();
    const telemetry = startPrivateLogs({
      serviceName: "eveland-worker",
      serviceInstanceId: "worker-1",
      environment: "production",
      teamId: "team_local",
      telemetryDomain: "runtime",
      otlpEndpoint: "http://127.0.0.1:4318",
      otlpServiceToken: "platform-service-token",
      exporter: logExporter,
    });

    telemetry.emitLog({
      severity: "info",
      eventName: "eveland.runtime.log",
      body: "Runtime became ready.",
      attributes: {
        "eveland.project.id": "proj_1",
        "eveland.deployment.id": "dep_1",
      },
    });
    await telemetry.forceFlush();

    expect(logExporter.getFinishedLogRecords()).toHaveLength(1);
    expect(logExporter.getFinishedLogRecords()[0]?.resource.attributes).toMatchObject({
      "service.name": "eveland-worker",
      "eveland.telemetry.domain": "runtime",
    });
    expect(logExporter.getFinishedLogRecords()[0]?.attributes).toMatchObject({
      "eveland.project.id": "proj_1",
      "eveland.deployment.id": "dep_1",
    });
    await telemetry.shutdown();
  });
});
