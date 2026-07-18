export type InstanceHealthStatus = "healthy" | "warning" | "critical" | "unavailable";

export type WorkerHeartbeat = {
  workerId: string;
  startedAt: string;
  observedAt: string;
  intervalMs: number;
  lastTickDurationMs: number;
  lastError: string | null;
};

export type HostMetricSample = {
  id: string;
  workerId: string;
  observedAt: string;
  cpuPercent: number | null;
  load1: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  diskTotalBytes: number;
  diskAvailableBytes: number;
  diskInodesTotal: number | null;
  diskInodesAvailable: number | null;
};

export type InstanceWorkload = {
  queuedJobs: number;
  runningJobs: number;
  oldestQueuedAt: string | null;
  runtimeInstances: Record<"starting" | "ready" | "draining" | "stopped" | "failed", number>;
};

export type InstanceComponentHealth = {
  key: "api" | "postgres" | "gateway" | "worker" | "collector";
  label: string;
  status: InstanceHealthStatus;
  message: string;
  observedAt: string | null;
};

export type InstanceHealthReport = {
  status: InstanceHealthStatus;
  generatedAt: string;
  historyHours: number;
  components: InstanceComponentHealth[];
  capacity: HostCapacityAnalysis;
  metrics: HostMetricSample[];
  workload: InstanceWorkload;
};

export type CapacityRisk = {
  code:
    | "disk_capacity"
    | "disk_projected_exhaustion"
    | "disk_inodes"
    | "memory_available"
    | "cpu_sustained";
  severity: "warning" | "critical";
  message: string;
};

export type HostCapacityAnalysis = {
  overall: "healthy" | "warning" | "critical";
  observedAt: string | null;
  disk: {
    usedPercent: number | null;
    availableBytes: number | null;
    projectedDaysRemaining: number | null;
  };
  memory: {
    usedPercent: number | null;
    availableBytes: number | null;
  };
  cpu: {
    percent: number | null;
    load1: number | null;
  };
  risks: CapacityRisk[];
};

export function summarizeWorkerHealth(
  heartbeat: WorkerHeartbeat | null,
  now = new Date(),
): { status: "healthy" | "warning" | "unavailable"; message: string; observedAt: string | null } {
  if (!heartbeat) {
    return {
      status: "unavailable",
      message: "Worker has not published a heartbeat.",
      observedAt: null,
    };
  }
  const staleAfterMs = Math.max(60_000, heartbeat.intervalMs * 6);
  if (now.getTime() - Date.parse(heartbeat.observedAt) > staleAfterMs) {
    return {
      status: "unavailable",
      message: "Worker heartbeat is stale.",
      observedAt: heartbeat.observedAt,
    };
  }
  if (heartbeat.lastError) {
    return {
      status: "warning",
      message: heartbeat.lastError,
      observedAt: heartbeat.observedAt,
    };
  }
  return {
    status: "healthy",
    message: "Worker heartbeat is current.",
    observedAt: heartbeat.observedAt,
  };
}

export function analyzeHostCapacity(samples: HostMetricSample[]): HostCapacityAnalysis {
  const ordered = [...samples].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const latest = ordered.at(-1);
  if (!latest) {
    return {
      overall: "healthy",
      observedAt: null,
      disk: { usedPercent: null, availableBytes: null, projectedDaysRemaining: null },
      memory: { usedPercent: null, availableBytes: null },
      cpu: { percent: null, load1: null },
      risks: [],
    };
  }

  const diskUsedPercent = percentUsed(latest.diskTotalBytes, latest.diskAvailableBytes);
  const memoryUsedPercent = percentUsed(latest.memoryTotalBytes, latest.memoryAvailableBytes);
  const projectedDaysRemaining = projectDiskExhaustionDays(ordered);
  const risks: CapacityRisk[] = [];

  if (diskUsedPercent >= 95) {
    risks.push({ code: "disk_capacity", severity: "critical", message: `Data filesystem is ${diskUsedPercent}% full.` });
  } else if (diskUsedPercent >= 85) {
    risks.push({ code: "disk_capacity", severity: "warning", message: `Data filesystem is ${diskUsedPercent}% full.` });
  }
  if (projectedDaysRemaining !== null && projectedDaysRemaining <= 14) {
    risks.push({
      code: "disk_projected_exhaustion",
      severity: projectedDaysRemaining <= 3 ? "critical" : "warning",
      message: `Recent growth projects disk exhaustion in about ${projectedDaysRemaining} days.`,
    });
  }
  if (latest.diskInodesTotal && latest.diskInodesAvailable !== null) {
    const inodeAvailablePercent = (latest.diskInodesAvailable / latest.diskInodesTotal) * 100;
    if (inodeAvailablePercent <= 5) {
      risks.push({ code: "disk_inodes", severity: "critical", message: "Fewer than 5% of filesystem inodes remain." });
    } else if (inodeAvailablePercent <= 15) {
      risks.push({ code: "disk_inodes", severity: "warning", message: "Fewer than 15% of filesystem inodes remain." });
    }
  }
  const memoryAvailablePercent = latest.memoryTotalBytes > 0
    ? (latest.memoryAvailableBytes / latest.memoryTotalBytes) * 100
    : 100;
  if (memoryAvailablePercent <= 5) {
    risks.push({ code: "memory_available", severity: "critical", message: "Less than 5% of host memory is available." });
  } else if (memoryAvailablePercent <= 15) {
    risks.push({ code: "memory_available", severity: "warning", message: "Less than 15% of host memory is available." });
  }
  const recentCpu = ordered.slice(-5).map((sample) => sample.cpuPercent).filter((value): value is number => value !== null);
  if (recentCpu.length >= 3 && recentCpu.every((value) => value >= 90)) {
    risks.push({ code: "cpu_sustained", severity: "warning", message: "Host CPU has remained above 90%." });
  }

  return {
    overall: risks.some((risk) => risk.severity === "critical")
      ? "critical"
      : risks.length > 0
        ? "warning"
        : "healthy",
    observedAt: latest.observedAt,
    disk: {
      usedPercent: diskUsedPercent,
      availableBytes: latest.diskAvailableBytes,
      projectedDaysRemaining,
    },
    memory: {
      usedPercent: memoryUsedPercent,
      availableBytes: latest.memoryAvailableBytes,
    },
    cpu: { percent: latest.cpuPercent, load1: latest.load1 },
    risks,
  };
}

function percentUsed(total: number, available: number): number {
  if (total <= 0) return 0;
  return Math.round((1 - available / total) * 1000) / 10;
}

function projectDiskExhaustionDays(samples: HostMetricSample[]): number | null {
  const first = samples[0];
  const latest = samples.at(-1);
  if (!first || !latest || first === latest) return null;
  const elapsedDays = (Date.parse(latest.observedAt) - Date.parse(first.observedAt)) / 86_400_000;
  const consumedBytes = first.diskAvailableBytes - latest.diskAvailableBytes;
  if (elapsedDays < 1 || consumedBytes <= 0) return null;
  const consumedPerDay = consumedBytes / elapsedDays;
  return Math.max(0, Math.round(latest.diskAvailableBytes / consumedPerDay));
}
