import {
  TELEMETRY_DOMAINS,
  agentEventObservationSchema,
  type AgentEventObservation,
  type ObservabilitySignal,
  type OtlpLogRecordProjection,
  type OtlpMetricDataType,
  type OtlpMetricPointProjection,
  type OtlpResourceProjection,
  type OtlpSpanProjection,
} from "@eveland/core/observability";
import type {
  HostMetricSample,
  WorkerHeartbeat,
} from "@eveland/core/instance-health";

export {
  decodeOtlpProtobufRequest,
  encodeOtlpProtobufResponse,
} from "./otlp-protobuf.js";

export type InstanceTelemetryProjection = {
  acceptedDataPoints: number;
  heartbeats: WorkerHeartbeat[];
  hostMetrics: Array<Omit<HostMetricSample, "id">>;
};

export function countOtlpSignalItems(
  signal: ObservabilitySignal,
  payload: Record<string, unknown>,
): number {
  if (signal === "traces") {
    return arrayOfRecords(payload.resourceSpans).reduce(
      (resourceTotal, resourceSpans) =>
        resourceTotal +
        arrayOfRecords(resourceSpans.scopeSpans).reduce(
          (scopeTotal, scopeSpans) =>
            scopeTotal + arrayOfRecords(scopeSpans.spans).length,
          0,
        ),
      0,
    );
  }
  if (signal === "logs") {
    return arrayOfRecords(payload.resourceLogs).reduce(
      (resourceTotal, resourceLogs) =>
        resourceTotal +
        arrayOfRecords(resourceLogs.scopeLogs).reduce(
          (scopeTotal, scopeLogs) =>
            scopeTotal + arrayOfRecords(scopeLogs.logRecords).length,
          0,
        ),
      0,
    );
  }
  return arrayOfRecords(payload.resourceMetrics).reduce(
    (resourceTotal, resourceMetrics) =>
      resourceTotal +
      arrayOfRecords(resourceMetrics.scopeMetrics).reduce(
        (scopeTotal, scopeMetrics) =>
          scopeTotal +
          arrayOfRecords(scopeMetrics.metrics).reduce(
            (metricTotal, metric) => {
              const data = metricData(metric);
              return (
                metricTotal +
                (data ? arrayOfRecords(data.value.dataPoints).length : 0)
              );
            },
            0,
          ),
        0,
      ),
    0,
  );
}

export function createOtlpPartialSuccessResponse(
  signal: ObservabilitySignal,
  rejectedItems: number,
): Record<string, unknown> {
  if (rejectedItems <= 0) return {};
  const rejectedField = {
    traces: "rejectedSpans",
    logs: "rejectedLogRecords",
    metrics: "rejectedDataPoints",
  }[signal];
  return {
    partialSuccess: {
      [rejectedField]: String(rejectedItems),
      errorMessage:
        "Telemetry items were rejected because required Eveland resource or OTLP signal fields were missing.",
    },
  };
}

export function projectOtlpSpans(
  payload: Record<string, unknown>,
): OtlpSpanProjection[] {
  const spans: OtlpSpanProjection[] = [];
  for (const resourceSpans of arrayOfRecords(payload.resourceSpans)) {
    const resource = resourceProjection(resourceSpans.resource);
    if (!resource) continue;

    for (const scopeSpans of arrayOfRecords(resourceSpans.scopeSpans)) {
      const scopeName =
        stringValue(recordValue(scopeSpans.scope)?.name) ?? null;
      for (const span of arrayOfRecords(scopeSpans.spans)) {
        const traceId = stringValue(span.traceId);
        const spanId = stringValue(span.spanId);
        const name = stringValue(span.name);
        const startedAt = unixNanoToIso(
          stringValue(span.startTimeUnixNano),
        );
        const endedAt = unixNanoToIso(
          stringValue(span.endTimeUnixNano),
        );
        const durationMs = durationBetweenUnixNano(
          stringValue(span.startTimeUnixNano),
          stringValue(span.endTimeUnixNano),
        );
        if (
          !traceId ||
          !spanId ||
          !name ||
          !startedAt ||
          !endedAt ||
          durationMs === undefined
        ) {
          continue;
        }
        const status = recordValue(span.status);
        spans.push({
          traceId,
          spanId,
          parentSpanId: stringValue(span.parentSpanId) ?? null,
          name,
          kind: finiteInteger(span.kind) ?? null,
          startedAt,
          endedAt,
          durationMs,
          statusCode: finiteInteger(status?.code) ?? null,
          statusMessage: stringValue(status?.message) ?? null,
          scopeName,
          attributes: attributesFrom(span.attributes),
          resource,
          payload: span,
        });
      }
    }
  }
  return spans;
}

export function projectOtlpLogRecords(
  payload: Record<string, unknown>,
): OtlpLogRecordProjection[] {
  const logs: OtlpLogRecordProjection[] = [];
  for (const resourceLogs of arrayOfRecords(payload.resourceLogs)) {
    const resource = resourceProjection(resourceLogs.resource);
    if (!resource) continue;

    for (const scopeLogs of arrayOfRecords(resourceLogs.scopeLogs)) {
      const scopeName =
        stringValue(recordValue(scopeLogs.scope)?.name) ?? null;
      for (const logRecord of arrayOfRecords(scopeLogs.logRecords)) {
        const timestamp = unixNanoToIso(
          stringValue(logRecord.timeUnixNano) ??
            stringValue(logRecord.observedTimeUnixNano),
        );
        if (!timestamp) continue;
        logs.push({
          traceId: stringValue(logRecord.traceId) ?? null,
          spanId: stringValue(logRecord.spanId) ?? null,
          timestamp,
          observedTimestamp:
            unixNanoToIso(
              stringValue(logRecord.observedTimeUnixNano),
            ) ?? null,
          severityNumber:
            finiteInteger(logRecord.severityNumber) ?? null,
          severityText: stringValue(logRecord.severityText) ?? null,
          eventName: stringValue(logRecord.eventName) ?? null,
          scopeName,
          body: anyValue(logRecord.body),
          attributes: attributesFrom(logRecord.attributes),
          resource,
          payload: logRecord,
        });
      }
    }
  }
  return logs;
}

export function projectOtlpMetricPoints(
  payload: Record<string, unknown>,
): OtlpMetricPointProjection[] {
  const points: OtlpMetricPointProjection[] = [];
  for (const resourceMetrics of arrayOfRecords(payload.resourceMetrics)) {
    const resource = resourceProjection(resourceMetrics.resource);
    if (!resource) continue;

    for (const scopeMetrics of arrayOfRecords(resourceMetrics.scopeMetrics)) {
      const scopeName =
        stringValue(recordValue(scopeMetrics.scope)?.name) ?? null;
      for (const metric of arrayOfRecords(scopeMetrics.metrics)) {
        const name = stringValue(metric.name);
        const data = metricData(metric);
        if (!name || !data) continue;
        for (const point of arrayOfRecords(data.value.dataPoints)) {
          const timestamp = unixNanoToIso(
            stringValue(point.timeUnixNano),
          );
          const value = metricPointValue(data.type, point);
          if (!timestamp || !value) continue;
          points.push({
            name,
            description: stringValue(metric.description) ?? null,
            unit: stringValue(metric.unit) ?? null,
            dataType: data.type,
            aggregationTemporality:
              finiteInteger(data.value.aggregationTemporality) ?? null,
            monotonic:
              typeof data.value.isMonotonic === "boolean"
                ? data.value.isMonotonic
                : null,
            startTimestamp:
              unixNanoToIso(
                stringValue(point.startTimeUnixNano),
              ) ?? null,
            timestamp,
            scopeName,
            attributes: attributesFrom(point.attributes),
            value,
            resource,
            payload: point,
          });
        }
      }
    }
  }
  return points;
}

export function projectAgentEventsFromOtlpLogs(
  payload: Record<string, unknown>,
  options: {
    resolveDeploymentId: (credential: string | undefined) => string | undefined;
  },
): AgentEventObservation[] {
  return projectAgentEventItemsFromOtlpLogs(payload, options).flatMap(
    (observation) => (observation ? [observation] : []),
  );
}

/**
 * `resolveDeploymentId` receives the Agent-supplied `eveland.deployment.credential`
 * and must return the deployment it authenticates, or null to drop the resource.
 * It is required rather than optional so no ingest path can silently fall back to
 * the unauthenticated `eveland.deployment.id` attribute, which any Agent with
 * access to the Collector's agent receiver can set to another tenant's id.
 */
export function projectAgentEventItemsFromOtlpLogs(
  payload: Record<string, unknown>,
  options: {
    resolveDeploymentId: (credential: string | undefined) => string | undefined;
  },
): Array<AgentEventObservation | null> {
  const observations: Array<AgentEventObservation | null> = [];
  for (const resourceLogs of arrayOfRecords(payload.resourceLogs)) {
    const resource = recordValue(resourceLogs.resource);
    const resourceAttributes = attributesFrom(resource?.attributes);
    const isAgent =
      resourceAttributes["eveland.telemetry.domain"] === "agent";
    const deploymentId = options.resolveDeploymentId(
      stringValue(resourceAttributes["eveland.deployment.credential"]),
    );
    const runtimeInstanceId =
      stringValue(resourceAttributes["eveland.runtime.instance.id"]) ?? null;

    for (const scopeLogs of arrayOfRecords(resourceLogs.scopeLogs)) {
      for (const logRecord of arrayOfRecords(scopeLogs.logRecords)) {
        observations.push(
          isAgent && deploymentId
            ? observationFromLogRecord(
                deploymentId,
                runtimeInstanceId,
                logRecord,
              )
            : null,
        );
      }
    }
  }
  return observations;
}

export function projectInstanceTelemetryFromOtlpMetrics(
  payload: Record<string, unknown>,
): InstanceTelemetryProjection {
  const projection: InstanceTelemetryProjection = {
    acceptedDataPoints: 0,
    heartbeats: [],
    hostMetrics: [],
  };
  for (const resourceMetrics of arrayOfRecords(payload.resourceMetrics)) {
    const resource = recordValue(resourceMetrics.resource);
    const resourceAttributes = attributesFrom(resource?.attributes);
    if (
      resourceAttributes["service.name"] !== "eveland-worker" ||
      resourceAttributes["eveland.telemetry.domain"] !== "capacity"
    ) {
      continue;
    }
    const workerId = stringValue(
      resourceAttributes["service.instance.id"],
    );
    if (!workerId) continue;
    const metrics = new Map<string, Record<string, unknown>[]>();
    for (const scopeMetrics of arrayOfRecords(resourceMetrics.scopeMetrics)) {
      for (const metric of arrayOfRecords(scopeMetrics.metrics)) {
        const name = stringValue(metric.name);
        if (name) metrics.set(name, metricDataPoints(metric));
      }
    }
    const observedAt = latestMetricTime(metrics);
    if (!observedAt) continue;

    const heartbeatPoint = metrics.get("eveland.worker.heartbeat")?.[0];
    if (heartbeatPoint) {
      const heartbeatAttributes = attributesFrom(
        heartbeatPoint.attributes,
      );
      const durationPoint = metrics.get(
        "eveland.worker.tick.duration",
      )?.[0];
      projection.heartbeats.push({
        workerId,
        startedAt:
          unixNanoToIso(stringValue(heartbeatPoint.startTimeUnixNano)) ??
          observedAt,
        observedAt,
        intervalMs:
          nonNegativeInteger(
            heartbeatAttributes["eveland.worker.poll_interval_ms"],
          ) ?? 5000,
        lastTickDurationMs: Math.max(
          0,
          Math.round(histogramMean(durationPoint) ?? 0),
        ),
        lastError:
          heartbeatAttributes["eveland.worker.tick.status"] === "error"
            ? "Worker tick failed; inspect Worker telemetry."
            : null,
      });
      projection.acceptedDataPoints += 1;
      if (histogramMean(durationPoint) !== undefined) {
        projection.acceptedDataPoints += 1;
      }
    }

    const memoryUsed = pointByAttribute(
      metrics,
      "system.memory.usage",
      "system.memory.state",
      "used",
    );
    const memoryFree = pointByAttribute(
      metrics,
      "system.memory.usage",
      "system.memory.state",
      "free",
    );
    const diskFree = pointByAttribute(
      metrics,
      "system.filesystem.usage",
      "system.filesystem.state",
      "free",
    );
    const diskLimit = firstPointValue(
      metrics,
      "system.filesystem.limit",
    );
    if (
      memoryUsed === undefined ||
      memoryFree === undefined ||
      diskFree === undefined ||
      diskLimit === undefined
    ) {
      continue;
    }
    const inodeFree = pointByAttribute(
      metrics,
      "eveland.system.filesystem.inodes.usage",
      "eveland.system.filesystem.inodes.state",
      "free",
    );
    const inodeLimit = firstPointValue(
      metrics,
      "eveland.system.filesystem.inodes.limit",
    );
    projection.hostMetrics.push({
      workerId,
      observedAt,
      cpuPercent: cpuPercent(metrics.get("system.cpu.utilization") ?? []),
      load1: firstPointValue(metrics, "eveland.host.load.1m") ?? 0,
      memoryTotalBytes: memoryUsed + memoryFree,
      memoryAvailableBytes: memoryFree,
      diskTotalBytes: diskLimit,
      diskAvailableBytes: diskFree,
      diskInodesTotal: inodeLimit ?? null,
      diskInodesAvailable:
        inodeFree === undefined ? null : inodeFree,
    });
    projection.acceptedDataPoints += acceptedHostMetricDataPoints(metrics);
  }
  return projection;
}

function acceptedHostMetricDataPoints(
  metrics: Map<string, Record<string, unknown>[]>,
): number {
  const cpuPoints = (metrics.get("system.cpu.utilization") ?? []).filter(
    (point) =>
      attributesFrom(point.attributes)["cpu.mode"] !== "idle" &&
      numberValue(point) !== undefined,
  ).length;
  return (
    cpuPoints +
    acceptedAttributeNumberPoint(
      metrics,
      "system.memory.usage",
      "system.memory.state",
      "used",
    ) +
    acceptedAttributeNumberPoint(
      metrics,
      "system.memory.usage",
      "system.memory.state",
      "free",
    ) +
    acceptedAttributeNumberPoint(
      metrics,
      "system.filesystem.usage",
      "system.filesystem.state",
      "free",
    ) +
    acceptedFirstNumberPoint(metrics, "system.filesystem.limit") +
    acceptedAttributeNumberPoint(
      metrics,
      "eveland.system.filesystem.inodes.usage",
      "eveland.system.filesystem.inodes.state",
      "free",
    ) +
    acceptedFirstNumberPoint(
      metrics,
      "eveland.system.filesystem.inodes.limit",
    ) +
    acceptedFirstNumberPoint(metrics, "eveland.host.load.1m")
  );
}

function acceptedFirstNumberPoint(
  metrics: Map<string, Record<string, unknown>[]>,
  name: string,
): number {
  return numberValue(metrics.get(name)?.[0]) === undefined ? 0 : 1;
}

function acceptedAttributeNumberPoint(
  metrics: Map<string, Record<string, unknown>[]>,
  name: string,
  attributeName: string,
  attributeValue: string,
): number {
  const point = metrics
    .get(name)
    ?.find(
      (candidate) =>
        attributesFrom(candidate.attributes)[attributeName] ===
        attributeValue,
    );
  return numberValue(point) === undefined ? 0 : 1;
}

function observationFromLogRecord(
  deploymentId: string,
  runtimeInstanceId: string | null,
  logRecord: Record<string, unknown>,
): AgentEventObservation | null {
  const attributes = attributesFrom(logRecord.attributes);
  const event = anyValue(logRecord.body);
  const eventRecord = recordValue(event);
  const data = recordValue(eventRecord?.data);
  const timestamp = unixNanoToIso(
    stringValue(logRecord.timeUnixNano) ??
      stringValue(logRecord.observedTimeUnixNano),
  );
  const candidate = {
    telemetryEventId: stringValue(attributes["eveland.event.id"]),
    eventFingerprint: stringValue(
      attributes["eveland.event.fingerprint"],
    ),
    deploymentId,
    runtimeInstanceId,
    eveSessionId: stringValue(attributes["eveland.eve.session.id"]),
    parentEveSessionId:
      stringValue(attributes["eveland.eve.parent_session.id"]) ?? null,
    sourceSequence: nonNegativeInteger(data?.sequence) ?? null,
    agent: {
      id:
        stringValue(recordValue(data?.runtime)?.agentId) ??
        stringValue(attributes["eveland.eve.agent.id"]) ??
        null,
      name:
        stringValue(recordValue(data?.runtime)?.agentName) ??
        stringValue(attributes["eveland.eve.agent.name"]) ??
        null,
      nodeId:
        stringValue(attributes["eveland.eve.agent.node.id"]) ?? null,
    },
    channelKind:
      stringValue(attributes["eveland.eve.channel.kind"]) ?? null,
    eventAt:
      stringValue(recordValue(eventRecord?.meta)?.at) ??
      timestamp,
    event,
  };
  const parsed = agentEventObservationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function attributesFrom(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    arrayOfRecords(value).flatMap((attribute) => {
      const key = stringValue(attribute.key);
      return key ? [[key, anyValue(attribute.value)]] : [];
    }),
  );
}

function resourceProjection(
  value: unknown,
): OtlpResourceProjection | undefined {
  const resource = recordValue(value);
  const attributes = attributesFrom(resource?.attributes);
  const serviceName = stringValue(attributes["service.name"]);
  const domain = TELEMETRY_DOMAINS.find(
    (candidate) =>
      candidate === attributes["eveland.telemetry.domain"],
  );
  if (!serviceName || !domain) return undefined;
  return {
    serviceName,
    domain,
    projectId:
      stringValue(attributes["eveland.project.id"]) ?? null,
    deploymentId:
      stringValue(attributes["eveland.deployment.id"]) ?? null,
    attributes,
  };
}

function metricDataPoints(
  metric: Record<string, unknown>,
): Record<string, unknown>[] {
  for (const kind of ["gauge", "sum", "histogram"] as const) {
    const data = recordValue(metric[kind]);
    if (data) return arrayOfRecords(data.dataPoints);
  }
  return [];
}

function metricData(
  metric: Record<string, unknown>,
):
  | {
      type: OtlpMetricDataType;
      value: Record<string, unknown>;
    }
  | undefined {
  const kinds = [
    ["gauge", "gauge"],
    ["sum", "sum"],
    ["histogram", "histogram"],
    ["exponentialHistogram", "exponential_histogram"],
    ["summary", "summary"],
  ] as const;
  for (const [field, type] of kinds) {
    const value = recordValue(metric[field]);
    if (value) return { type, value };
  }
  return undefined;
}

function metricPointValue(
  type: OtlpMetricDataType,
  point: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (type === "gauge" || type === "sum") {
    if ("asDouble" in point) {
      const asDouble = finiteNumber(point.asDouble);
      return asDouble === undefined ? undefined : { asDouble };
    }
    const asInt = numericJsonValue(point.asInt);
    return asInt === undefined ? undefined : { asInt };
  }

  const count = numericJsonValue(point.count);
  if (count === undefined) return undefined;
  if (type === "summary") {
    return compactRecord({
      count,
      sum: finiteNumber(point.sum),
      quantileValues: arrayOfRecords(point.quantileValues).flatMap(
        (quantileValue) => {
          const quantile = finiteNumber(quantileValue.quantile);
          const value = finiteNumber(quantileValue.value);
          return quantile === undefined || value === undefined
            ? []
            : [{ quantile, value }];
        },
      ),
    });
  }
  if (type === "exponential_histogram") {
    return compactRecord({
      count,
      sum: finiteNumber(point.sum),
      min: finiteNumber(point.min),
      max: finiteNumber(point.max),
      scale: finiteInteger(point.scale),
      zeroCount: numericJsonValue(point.zeroCount),
      positive: exponentialBuckets(point.positive),
      negative: exponentialBuckets(point.negative),
      zeroThreshold: finiteNumber(point.zeroThreshold),
    });
  }
  return compactRecord({
    count,
    sum: finiteNumber(point.sum),
    min: finiteNumber(point.min),
    max: finiteNumber(point.max),
    bucketCounts: numericJsonArray(point.bucketCounts),
    explicitBounds: finiteNumberArray(point.explicitBounds),
  });
}

function exponentialBuckets(
  value: unknown,
): Record<string, unknown> | undefined {
  const buckets = recordValue(value);
  if (!buckets) return undefined;
  const offset = finiteInteger(buckets.offset);
  const bucketCounts = numericJsonArray(buckets.bucketCounts);
  return offset === undefined || !bucketCounts
    ? undefined
    : { offset, bucketCounts };
}

function compactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
}

function numericJsonArray(value: unknown): Array<number | string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(numericJsonValue);
  return values.every(
    (item): item is number | string => item !== undefined,
  )
    ? values
    : undefined;
}

function finiteNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(finiteNumber);
  return values.every((item): item is number => item !== undefined)
    ? values
    : undefined;
}

function numericJsonValue(value: unknown): number | string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    return undefined;
  }
  try {
    const integer = BigInt(value);
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) &&
      integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(integer)
      : value;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function latestMetricTime(
  metrics: Map<string, Record<string, unknown>[]>,
): string | undefined {
  let latest: string | undefined;
  for (const points of metrics.values()) {
    for (const point of points) {
      const value = unixNanoToIso(stringValue(point.timeUnixNano));
      if (value && (!latest || value > latest)) latest = value;
    }
  }
  return latest;
}

function firstPointValue(
  metrics: Map<string, Record<string, unknown>[]>,
  name: string,
): number | undefined {
  return numberValue(metrics.get(name)?.[0]);
}

function pointByAttribute(
  metrics: Map<string, Record<string, unknown>[]>,
  name: string,
  attributeName: string,
  attributeValue: string,
): number | undefined {
  return numberValue(
    metrics
      .get(name)
      ?.find(
        (point) =>
          attributesFrom(point.attributes)[attributeName] ===
          attributeValue,
      ),
  );
}

function cpuPercent(points: Record<string, unknown>[]): number | null {
  const byCpu = new Map<string, number>();
  for (const point of points) {
    const attributes = attributesFrom(point.attributes);
    const mode = stringValue(attributes["cpu.mode"]);
    if (mode === "idle") continue;
    const logicalNumber = String(
      attributes["cpu.logical_number"] ?? "all",
    );
    const value = numberValue(point);
    if (value === undefined) continue;
    byCpu.set(logicalNumber, (byCpu.get(logicalNumber) ?? 0) + value);
  }
  if (byCpu.size === 0) return null;
  const average =
    [...byCpu.values()].reduce((sum, value) => sum + value, 0) /
    byCpu.size;
  return Math.round(average * 1000) / 10;
}

function numberValue(
  point: Record<string, unknown> | undefined,
): number | undefined {
  if (!point) return undefined;
  for (const field of ["asDouble", "asInt"] as const) {
    if (!(field in point)) continue;
    const parsed = Number(point[field]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function histogramMean(
  point: Record<string, unknown> | undefined,
): number | undefined {
  if (!point) return undefined;
  const count = Number(point.count);
  const sum = Number(point.sum);
  return Number.isFinite(count) &&
    count > 0 &&
    Number.isFinite(sum)
    ? sum / count
    : undefined;
}

function anyValue(value: unknown): unknown {
  const record = recordValue(value);
  if (!record) return undefined;
  if ("stringValue" in record) return stringValue(record.stringValue) ?? "";
  if ("boolValue" in record) return record.boolValue === true;
  if ("intValue" in record) {
    const parsed = Number(record.intValue);
    return Number.isSafeInteger(parsed) ? parsed : String(record.intValue);
  }
  if ("doubleValue" in record) {
    const parsed = Number(record.doubleValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const arrayValue = recordValue(record.arrayValue);
  if (arrayValue) return arrayOfRecords(arrayValue.values).map(anyValue);
  const keyValueList = recordValue(record.kvlistValue);
  if (keyValueList) {
    return Object.fromEntries(
      arrayOfRecords(keyValueList.values).flatMap((entry) => {
        const key = stringValue(entry.key);
        return key ? [[key, anyValue(entry.value)]] : [];
      }),
    );
  }
  if ("bytesValue" in record) return stringValue(record.bytesValue);
  return null;
}

function unixNanoToIso(value: string | undefined): string | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  try {
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  } catch {
    return undefined;
  }
}

function durationBetweenUnixNano(
  start: string | undefined,
  end: string | undefined,
): number | undefined {
  if (
    !start ||
    !end ||
    !/^\d+$/.test(start) ||
    !/^\d+$/.test(end)
  ) {
    return undefined;
  }
  try {
    const duration = BigInt(end) - BigInt(start);
    if (duration < 0n) return undefined;
    const milliseconds = Number(duration) / 1_000_000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  } catch {
    return undefined;
  }
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordValue(item);
        return record ? [record] : [];
      })
    : [];
}

function recordValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
