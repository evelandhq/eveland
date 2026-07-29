import type { Meter } from "@opentelemetry/api";
import { collectHostMetric, type CpuTimes } from "./host-metrics.js";

type MetricCollector = typeof collectHostMetric;

export function createWorkerTelemetry(
  meter: Meter,
  options: {
    workerId: string;
    dataDir: string;
    intervalMs: number;
    metricIntervalMs: number;
    startedAt?: Date;
    now?: () => Date;
    collect?: MetricCollector;
    onMetricError?: (error: unknown) => void;
  },
) {
  const startedAt = options.startedAt ?? new Date();
  const now = options.now ?? (() => new Date());
  const collect = options.collect ?? collectHostMetric;
  const commonAttributes = {
    "eveland.telemetry.domain": "capacity",
    "eveland.worker.id": options.workerId,
  };
  const filesystemAttributes = {
    ...commonAttributes,
    "system.filesystem.mountpoint": options.dataDir,
  };
  const heartbeat = meter.createCounter("eveland.worker.heartbeat", {
    description: "Worker control-loop heartbeat count.",
    unit: "{heartbeat}",
  });
  const uptime = meter.createGauge("eveland.worker.uptime", {
    description: "Elapsed time since the Worker process started.",
    unit: "s",
  });
  const tickDuration = meter.createHistogram(
    "eveland.worker.tick.duration",
    {
      description: "Worker control-loop execution duration.",
      unit: "ms",
    },
  );
  const tickFailures = meter.createCounter("eveland.worker.tick.failures", {
    description: "Worker control-loop failure count.",
    unit: "{failure}",
  });
  const capacityFailures = meter.createCounter(
    "eveland.worker.capacity.collection.failures",
    {
      description: "Host capacity collection failure count.",
      unit: "{failure}",
    },
  );
  const loadOneMinute = meter.createGauge("eveland.host.load.1m", {
    description: "Host one-minute load average.",
    unit: "1",
  });
  const filesystemUsage = meter.createGauge("system.filesystem.usage", {
    description: "Filesystem space by usage state.",
    unit: "By",
  });
  const filesystemLimit = meter.createGauge("system.filesystem.limit", {
    description: "Filesystem total capacity.",
    unit: "By",
  });
  const filesystemUtilization = meter.createGauge(
    "system.filesystem.utilization",
    {
      description: "Fraction of filesystem bytes used.",
      unit: "1",
    },
  );
  const inodeUsage = meter.createGauge(
    "eveland.system.filesystem.inodes.usage",
    {
      description: "Filesystem inode count by usage state.",
      unit: "{inode}",
    },
  );
  const inodeLimit = meter.createGauge(
    "eveland.system.filesystem.inodes.limit",
    {
      description: "Filesystem inode capacity.",
      unit: "{inode}",
    },
  );
  let previousCpuTimes: CpuTimes | null = null;
  let lastMetricAt = Number.NEGATIVE_INFINITY;

  return {
    async publishTick(input: {
      durationMs: number;
      error: unknown | null;
    }): Promise<void> {
      const observedAt = now();
      const tickAttributes = {
        ...commonAttributes,
        "eveland.worker.tick.status": input.error ? "error" : "ok",
        "eveland.worker.poll_interval_ms": options.intervalMs,
      };
      heartbeat.add(1, tickAttributes);
      uptime.record(
        Math.max(0, (observedAt.getTime() - startedAt.getTime()) / 1_000),
        commonAttributes,
      );
      tickDuration.record(Math.max(0, input.durationMs), tickAttributes);
      if (input.error) tickFailures.add(1, commonAttributes);

      if (
        observedAt.getTime() - lastMetricAt <
        options.metricIntervalMs
      ) {
        return;
      }
      lastMetricAt = observedAt.getTime();

      try {
        const result = await collect(
          options.workerId,
          options.dataDir,
          previousCpuTimes,
        );
        previousCpuTimes = result.cpuTimes;
        recordCapacity(result.sample);
      } catch (error) {
        capacityFailures.add(1, commonAttributes);
        options.onMetricError?.(error);
      }
    },
  };

  function recordCapacity(
    sample: Awaited<ReturnType<MetricCollector>>["sample"],
  ): void {
    const diskUsed = Math.max(
      0,
      sample.diskTotalBytes - sample.diskAvailableBytes,
    );
    filesystemUsage.record(diskUsed, {
      ...filesystemAttributes,
      "system.filesystem.state": "used",
    });
    filesystemUsage.record(sample.diskAvailableBytes, {
      ...filesystemAttributes,
      "system.filesystem.state": "free",
    });
    filesystemLimit.record(sample.diskTotalBytes, filesystemAttributes);
    if (sample.diskTotalBytes > 0) {
      filesystemUtilization.record(
        diskUsed / sample.diskTotalBytes,
        filesystemAttributes,
      );
    }

    if (
      sample.diskInodesTotal !== null &&
      sample.diskInodesAvailable !== null
    ) {
      const inodesUsed = Math.max(
        0,
        sample.diskInodesTotal - sample.diskInodesAvailable,
      );
      inodeUsage.record(inodesUsed, {
        ...filesystemAttributes,
        "eveland.system.filesystem.inodes.state": "used",
      });
      inodeUsage.record(sample.diskInodesAvailable, {
        ...filesystemAttributes,
        "eveland.system.filesystem.inodes.state": "free",
      });
      inodeLimit.record(sample.diskInodesTotal, filesystemAttributes);
    }
    loadOneMinute.record(sample.load1, commonAttributes);
  }
}
