import {
  agentEventObservationSchema,
  type AgentEventObservation,
} from "@eveland/core/observability";
import type {
  HostMetricSample,
  WorkerHeartbeat,
} from "@eveland/core/instance-health";

export type InstanceTelemetryProjection = {
  heartbeats: WorkerHeartbeat[];
  hostMetrics: Array<Omit<HostMetricSample, "id">>;
};

export function projectAgentEventsFromOtlpLogs(
  payload: Record<string, unknown>,
): AgentEventObservation[] {
  const observations: AgentEventObservation[] = [];
  for (const resourceLogs of arrayOfRecords(payload.resourceLogs)) {
    const resource = recordValue(resourceLogs.resource);
    const resourceAttributes = attributesFrom(resource?.attributes);
    if (resourceAttributes["eveland.telemetry.domain"] !== "agent") continue;
    const deploymentId = stringValue(
      resourceAttributes["eveland.deployment.id"],
    );
    if (!deploymentId) continue;
    const runtimeInstanceId =
      stringValue(resourceAttributes["eveland.runtime.instance.id"]) ?? null;

    for (const scopeLogs of arrayOfRecords(resourceLogs.scopeLogs)) {
      for (const logRecord of arrayOfRecords(scopeLogs.logRecords)) {
        const observation = observationFromLogRecord(
          deploymentId,
          runtimeInstanceId,
          logRecord,
        );
        if (observation) observations.push(observation);
      }
    }
  }
  return observations;
}

export function projectInstanceTelemetryFromOtlpMetrics(
  payload: Record<string, unknown>,
): InstanceTelemetryProjection {
  const projection: InstanceTelemetryProjection = {
    heartbeats: [],
    hostMetrics: [],
  };
  for (const resourceMetrics of arrayOfRecords(payload.resourceMetrics)) {
    const resource = recordValue(resourceMetrics.resource);
    const resourceAttributes = attributesFrom(resource?.attributes);
    if (resourceAttributes["service.name"] !== "eveland-worker") continue;
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
    const diskUsed = pointByAttribute(
      metrics,
      "system.filesystem.usage",
      "system.filesystem.state",
      "used",
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
      diskAvailableBytes:
        diskFree ??
        (diskUsed === undefined
          ? diskLimit
          : Math.max(0, diskLimit - diskUsed)),
      diskInodesTotal: inodeLimit ?? null,
      diskInodesAvailable:
        inodeFree === undefined ? null : inodeFree,
    });
  }
  return projection;
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

function metricDataPoints(
  metric: Record<string, unknown>,
): Record<string, unknown>[] {
  for (const kind of ["gauge", "sum", "histogram"] as const) {
    const data = recordValue(metric[kind]);
    if (data) return arrayOfRecords(data.dataPoints);
  }
  return [];
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
