export type CollectorHealthStatus = "healthy" | "delayed" | "degraded";

export type CollectorHealth = {
  status: CollectorHealthStatus;
  lastProcessedAt: string | null;
  backlogEvents: number;
  backlogBytes: number;
  oldestEventAge: number;
  quarantinedEvents: number;
  lastError: string | null;
};

export function createCollectorHealth(): CollectorHealth {
  return {
    status: "healthy",
    lastProcessedAt: null,
    backlogEvents: 0,
    backlogBytes: 0,
    oldestEventAge: 0,
    quarantinedEvents: 0,
    lastError: null,
  };
}
