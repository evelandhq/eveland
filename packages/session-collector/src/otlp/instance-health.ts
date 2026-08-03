import type {
  HostMetricSample,
  PgInstanceConnectionSample,
  WorkerHeartbeat,
} from "@eveland/core/instance-health";
import {
  arrayOfRecords,
  attributesFrom,
  histogramMean,
  metricDataPoints,
  nonNegativeInteger,
  numberValue,
  recordValue,
  stringValue,
  unixNanoToIso,
} from "./values.js";

export type InstanceTelemetryProjection = {
  acceptedDataPoints: number;
  heartbeats: WorkerHeartbeat[];
  hostMetrics: Array<Omit<HostMetricSample, "id">>;
};

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
    const workerId = stringValue(resourceAttributes["service.instance.id"]);
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

    projectHeartbeat(projection, metrics, workerId, observedAt);
    projectHostMetrics(projection, metrics, workerId, observedAt);
  }
  return projection;
}

function projectHeartbeat(
  projection: InstanceTelemetryProjection,
  metrics: Map<string, Record<string, unknown>[]>,
  workerId: string,
  observedAt: string,
): void {
  const heartbeatPoint = metrics.get("eveland.worker.heartbeat")?.[0];
  if (!heartbeatPoint) return;
  const heartbeatAttributes = attributesFrom(heartbeatPoint.attributes);
  const durationPoint = metrics.get("eveland.worker.tick.duration")?.[0];
  const heavyJobCap = nonNegativeInteger(
    heartbeatAttributes["eveland.worker.max_concurrent_heavy_jobs"],
  );
  projection.heartbeats.push({
    workerId,
    startedAt: unixNanoToIso(stringValue(heartbeatPoint.startTimeUnixNano)) ?? observedAt,
    observedAt,
    intervalMs: nonNegativeInteger(heartbeatAttributes["eveland.worker.poll_interval_ms"]) ?? 5000,
    lastTickDurationMs: Math.max(0, Math.round(histogramMean(durationPoint) ?? 0)),
    lastError:
      heartbeatAttributes["eveland.worker.tick.status"] === "error"
        ? "Worker tick failed; inspect Worker telemetry."
        : null,
    // Workers that predate the heavy-job cap publish no attribute; a cap is
    // always at least one, so zero is equally treated as absent.
    maxConcurrentHeavyJobs: heavyJobCap ? heavyJobCap : null,
  });
  projection.acceptedDataPoints += 1;
  if (histogramMean(durationPoint) !== undefined) {
    projection.acceptedDataPoints += 1;
  }
}

function projectHostMetrics(
  projection: InstanceTelemetryProjection,
  metrics: Map<string, Record<string, unknown>[]>,
  workerId: string,
  observedAt: string,
): void {
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
  const diskLimit = firstPointValue(metrics, "system.filesystem.limit");
  if (
    memoryUsed === undefined ||
    memoryFree === undefined ||
    diskFree === undefined ||
    diskLimit === undefined
  ) {
    return;
  }
  const inodeFree = pointByAttribute(
    metrics,
    "eveland.system.filesystem.inodes.usage",
    "eveland.system.filesystem.inodes.state",
    "free",
  );
  const inodeLimit = firstPointValue(metrics, "eveland.system.filesystem.inodes.limit");
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
    diskInodesAvailable: inodeFree === undefined ? null : inodeFree,
    cpuCores: firstPointValue(metrics, "eveland.host.cpu.logical.count") ?? null,
    pgConnections: pgConnectionSamples(metrics),
  });
  projection.acceptedDataPoints += acceptedHostMetricDataPoints(metrics);
}

const pgInstanceRoles = ["shared", "control", "workflow"] as const;

/**
 * Reassembles the per-instance connection samples the worker flattened into
 * role-attributed gauge points. An instance needs both its usage and limit
 * point to count; the pool-size point is optional because control-only
 * instances never carry one.
 */
function pgConnectionSamples(
  metrics: Map<string, Record<string, unknown>[]>,
): PgInstanceConnectionSample[] | null {
  const samples: PgInstanceConnectionSample[] = [];
  for (const role of pgInstanceRoles) {
    const used = pointByAttribute(
      metrics,
      "eveland.postgres.connections.usage",
      "eveland.postgres.role",
      role,
    );
    const limit = pointByAttribute(
      metrics,
      "eveland.postgres.connections.limit",
      "eveland.postgres.role",
      role,
    );
    if (used === undefined || limit === undefined) continue;
    const poolSize = pointByAttribute(
      metrics,
      "eveland.postgres.agent_pool_size",
      "eveland.postgres.role",
      role,
    );
    samples.push({
      role,
      usedConnections: used,
      maxConnections: limit,
      agentPoolSize: poolSize === undefined ? null : poolSize,
    });
  }
  return samples.length > 0 ? samples : null;
}

function acceptedHostMetricDataPoints(metrics: Map<string, Record<string, unknown>[]>): number {
  const cpuPoints = (metrics.get("system.cpu.utilization") ?? []).filter(
    (point) =>
      attributesFrom(point.attributes)["cpu.mode"] !== "idle" && numberValue(point) !== undefined,
  ).length;
  return (
    cpuPoints +
    acceptedAttributeNumberPoint(metrics, "system.memory.usage", "system.memory.state", "used") +
    acceptedAttributeNumberPoint(metrics, "system.memory.usage", "system.memory.state", "free") +
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
    acceptedFirstNumberPoint(metrics, "eveland.system.filesystem.inodes.limit") +
    acceptedFirstNumberPoint(metrics, "eveland.host.load.1m") +
    acceptedFirstNumberPoint(metrics, "eveland.host.cpu.logical.count") +
    acceptedPgConnectionPoints(metrics)
  );
}

function acceptedPgConnectionPoints(metrics: Map<string, Record<string, unknown>[]>): number {
  let accepted = 0;
  for (const name of [
    "eveland.postgres.connections.usage",
    "eveland.postgres.connections.limit",
    "eveland.postgres.agent_pool_size",
  ]) {
    for (const role of pgInstanceRoles) {
      accepted += acceptedAttributeNumberPoint(metrics, name, "eveland.postgres.role", role);
    }
  }
  return accepted;
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
    ?.find((candidate) => attributesFrom(candidate.attributes)[attributeName] === attributeValue);
  return numberValue(point) === undefined ? 0 : 1;
}

function latestMetricTime(metrics: Map<string, Record<string, unknown>[]>): string | undefined {
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
      ?.find((point) => attributesFrom(point.attributes)[attributeName] === attributeValue),
  );
}

function cpuPercent(points: Record<string, unknown>[]): number | null {
  const byCpu = new Map<string, number>();
  for (const point of points) {
    const attributes = attributesFrom(point.attributes);
    const mode = stringValue(attributes["cpu.mode"]);
    if (mode === "idle") continue;
    const logicalNumber = String(attributes["cpu.logical_number"] ?? "all");
    const value = numberValue(point);
    if (value === undefined) continue;
    byCpu.set(logicalNumber, (byCpu.get(logicalNumber) ?? 0) + value);
  }
  if (byCpu.size === 0) return null;
  const average = [...byCpu.values()].reduce((sum, value) => sum + value, 0) / byCpu.size;
  return Math.round(average * 1000) / 10;
}
