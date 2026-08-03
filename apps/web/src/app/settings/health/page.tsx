import Link from "next/link";
import { AlertTriangleIcon, CheckCircle2Icon, ShieldCheckIcon } from "lucide-react";
import type { InstanceHealthStatus } from "@eveland/core/instance-health";
import { CapacityTrend } from "@/components/capacity-trend";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/instance-health";
import { getCurrentMember, getInstanceHealth } from "@/lib/server-api";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Instance health",
};

export default async function InstanceHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>;
}) {
  const currentMember = await getCurrentMember();
  if (currentMember.role !== "admin") {
    return (
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>Administrator access required</AlertTitle>
        <AlertDescription>
          Instance health and host capacity are available only to Team administrators.
        </AlertDescription>
      </Alert>
    );
  }

  const requestedHours = Number((await searchParams).hours ?? 24);
  const historyHours = requestedHours === 168 ? 168 : 24;
  const report = await getInstanceHealth(historyHours);
  const latest = report.metrics.at(-1) ?? null;
  const componentRisks = report.components.filter((component) => component.status !== "healthy");
  const diskPoints = report.metrics.map((metric) => ({
    observedAt: metric.observedAt,
    value: percentUsed(metric.diskTotalBytes, metric.diskAvailableBytes),
  }));
  const memoryPoints = report.metrics.map((metric) => ({
    observedAt: metric.observedAt,
    value: percentUsed(metric.memoryTotalBytes, metric.memoryAvailableBytes),
  }));
  const cpuPoints = report.metrics.flatMap((metric) =>
    metric.cpuPercent === null
      ? []
      : [
          {
            observedAt: metric.observedAt,
            value: metric.cpuPercent,
          },
        ],
  );

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">Instance health</h2>
            <HealthBadge status={report.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Service availability, host headroom, and workload pressure.
          </p>
        </div>
        <div className="flex items-center gap-1" aria-label="History range">
          {[24, 168].map((hours) => (
            <Link
              key={hours}
              href={`/settings/health?hours=${hours}`}
              className={cn(
                buttonVariants({
                  variant: historyHours === hours ? "secondary" : "ghost",
                  size: "sm",
                }),
              )}
            >
              {hours === 24 ? "24 hours" : "7 days"}
            </Link>
          ))}
        </div>
      </header>

      <section aria-labelledby="risks-heading" className="flex flex-col gap-3">
        <div>
          <h3 id="risks-heading" className="text-sm font-semibold">
            Current risks
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Issues that can interrupt deploys, traffic, or observation.
          </p>
        </div>
        {report.capacity.risks.length === 0 && componentRisks.length === 0 ? (
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>No current risks</AlertTitle>
            <AlertDescription>
              Components are reachable and sampled host capacity has sufficient headroom.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-2">
            {report.capacity.risks.map((risk) => (
              <Alert
                key={risk.code}
                variant={risk.severity === "critical" ? "destructive" : "default"}
              >
                <AlertTriangleIcon />
                <AlertTitle>
                  {risk.severity === "critical" ? "Critical capacity risk" : "Capacity warning"}
                </AlertTitle>
                <AlertDescription>{risk.message}</AlertDescription>
              </Alert>
            ))}
            {componentRisks.map((component) => (
              <Alert
                key={component.key}
                variant={component.status === "unavailable" ? "destructive" : "default"}
              >
                <AlertTriangleIcon />
                <AlertTitle>
                  {component.label} {component.status}
                </AlertTitle>
                <AlertDescription>{component.message}</AlertDescription>
              </Alert>
            ))}
          </div>
        )}
      </section>

      <Separator />

      <section aria-labelledby="components-heading" className="flex flex-col gap-3">
        <div>
          <h3 id="components-heading" className="text-sm font-semibold">
            Components
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Current evidence from the control plane and runtime path.
          </p>
        </div>
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Component</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead>Observed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.components.map((component) => (
                <TableRow key={component.key}>
                  <TableCell className="font-medium">{component.label}</TableCell>
                  <TableCell>
                    <HealthBadge status={component.status} />
                  </TableCell>
                  <TableCell className="max-w-md text-muted-foreground">
                    {component.message}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {component.observedAt ? (
                      <DateTime value={component.observedAt} />
                    ) : (
                      "No observation"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <Separator />

      <section aria-labelledby="capacity-heading" className="flex flex-col gap-4">
        <div>
          <h3 id="capacity-heading" className="text-sm font-semibold">
            Capacity
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Filesystem, memory, and CPU measurements published by the Worker host.
          </p>
          {hostSpec(report.capacity) ? (
            <p className="mt-1 text-xs text-muted-foreground">Host: {hostSpec(report.capacity)}</p>
          ) : null}
        </div>
        <div className="grid divide-y border-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          <div className="lg:pr-5">
            <CapacityTrend
              label="Disk used"
              value={percentLabel(report.capacity.disk.usedPercent)}
              points={diskPoints}
              hours={historyHours}
              detail={availabilityDetail(
                report.capacity.disk.availableBytes,
                report.capacity.disk.totalBytes,
              )}
            />
          </div>
          <div className="lg:px-5">
            <CapacityTrend
              label="Memory used"
              value={percentLabel(report.capacity.memory.usedPercent)}
              points={memoryPoints}
              hours={historyHours}
              detail={availabilityDetail(
                report.capacity.memory.availableBytes,
                report.capacity.memory.totalBytes,
              )}
            />
          </div>
          <div className="lg:pl-5">
            <CapacityTrend
              label="CPU"
              value={percentLabel(report.capacity.cpu.percent)}
              points={cpuPoints}
              hours={historyHours}
              detail={`Load ${report.capacity.cpu.load1?.toFixed(2) ?? "—"}${
                report.capacity.cpu.cores === null ? "" : ` on ${report.capacity.cpu.cores} cores`
              }`}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {report.capacity.disk.projectedDaysRemaining === null
            ? "A disk exhaustion forecast appears after at least one day of measurable growth."
            : `At the recent growth rate, available disk is projected to last about ${report.capacity.disk.projectedDaysRemaining} days.`}
        </p>
      </section>

      {report.capacity.postgres.instances.length > 0 ? (
        <>
          <Separator />

          <section aria-labelledby="connections-heading" className="flex flex-col gap-3">
            <div>
              <h3 id="connections-heading" className="text-sm font-semibold">
                Postgres connection budget
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Every running Agent holds a connection pool; when max_connections is exhausted, new
                deployments fail at startup.
              </p>
            </div>
            <dl className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2">
              {report.capacity.postgres.instances.map((instance) => (
                <div key={instance.role} className="bg-background p-4">
                  <dt className="text-xs text-muted-foreground">{pgRoleLabels[instance.role]}</dt>
                  <dd className="mt-2 text-2xl font-semibold tabular-nums">
                    {instance.usedConnections}
                    <span className="text-sm font-normal text-muted-foreground">
                      {" "}
                      / {instance.maxConnections} connections
                    </span>
                  </dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {instance.usedPercent}% used
                    {instance.estimatedAdditionalAgents === null
                      ? ""
                      : ` · room for ~${instance.estimatedAdditionalAgents} more running Agent${
                          instance.estimatedAdditionalAgents === 1 ? "" : "s"
                        }`}
                  </p>
                </div>
              ))}
            </dl>
          </section>
        </>
      ) : null}

      <Separator />

      <section aria-labelledby="workload-heading" className="flex flex-col gap-3">
        <div>
          <h3 id="workload-heading" className="text-sm font-semibold">
            Workload
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Current queue pressure and RuntimeInstance lifecycle distribution.
          </p>
        </div>
        <dl className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-5">
          <WorkloadValue label="Queued jobs" value={report.workload.queuedJobs} />
          <WorkloadValue label="Running jobs" value={report.workload.runningJobs} />
          <WorkloadValue
            label="Running builds"
            value={
              report.workload.maxConcurrentHeavyJobs === null
                ? report.workload.runningHeavyJobs
                : `${report.workload.runningHeavyJobs}/${report.workload.maxConcurrentHeavyJobs}`
            }
          />
          <WorkloadValue label="Ready runtimes" value={report.workload.runtimeInstances.ready} />
          <WorkloadValue
            label="Starting runtimes"
            value={report.workload.runtimeInstances.starting}
          />
        </dl>
        <p className="text-xs text-muted-foreground">
          Oldest queued job:{" "}
          {report.workload.oldestQueuedAt ? (
            <DateTime value={report.workload.oldestQueuedAt} />
          ) : (
            "None"
          )}
          {latest ? (
            <>
              {" "}
              · Latest host sample <DateTime value={latest.observedAt} />
            </>
          ) : (
            " · No host samples yet"
          )}
        </p>
      </section>
    </div>
  );
}

function HealthBadge({ status }: { status: InstanceHealthStatus }) {
  return (
    <Badge
      variant={
        status === "critical" || status === "unavailable"
          ? "destructive"
          : status === "warning"
            ? "secondary"
            : "outline"
      }
    >
      {status}
    </Badge>
  );
}

function WorkloadValue({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-background p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

const pgRoleLabels = {
  shared: "Postgres (control plane + workflows)",
  control: "Control-plane Postgres",
  workflow: "Workflow Postgres",
} as const;

function hostSpec(capacity: {
  cpu: { cores: number | null };
  memory: { totalBytes: number | null };
  disk: { totalBytes: number | null };
}): string | null {
  const parts = [
    capacity.cpu.cores === null ? null : `${capacity.cpu.cores} CPU cores`,
    capacity.memory.totalBytes === null
      ? null
      : `${formatBytes(capacity.memory.totalBytes)} memory`,
    capacity.disk.totalBytes === null ? null : `${formatBytes(capacity.disk.totalBytes)} disk`,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function availabilityDetail(availableBytes: number | null, totalBytes: number | null): string {
  if (totalBytes === null) return `${formatBytes(availableBytes)} available`;
  return `${formatBytes(availableBytes)} of ${formatBytes(totalBytes)} available`;
}

function percentUsed(total: number, available: number): number {
  return total > 0 ? Math.round((1 - available / total) * 1000) / 10 : 0;
}

function percentLabel(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}
