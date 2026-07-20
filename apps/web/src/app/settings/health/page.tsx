import Link from "next/link";
import { AlertTriangleIcon, CheckCircle2Icon, ShieldCheckIcon } from "lucide-react";
import type { InstanceHealthStatus } from "@eveland/core/instance-health";
import { CapacityProgress } from "@/components/capacity-progress";
import { CapacityTrend } from "@/components/capacity-trend";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
        <AlertDescription>Instance health and host capacity are available only to Team administrators.</AlertDescription>
      </Alert>
    );
  }

  const requestedHours = Number((await searchParams).hours ?? 24);
  const historyHours = requestedHours === 168 ? 168 : 24;
  const report = await getInstanceHealth(historyHours);
  const latest = report.metrics.at(-1) ?? null;
  const componentRisks = report.components.filter((component) => component.status !== "healthy");
  const diskValues = report.metrics.map((metric) => percentUsed(metric.diskTotalBytes, metric.diskAvailableBytes));
  const memoryValues = report.metrics.map((metric) => percentUsed(metric.memoryTotalBytes, metric.memoryAvailableBytes));
  const cpuValues = report.metrics.flatMap((metric) => metric.cpuPercent === null ? [] : [metric.cpuPercent]);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">Instance health</h2>
            <HealthBadge status={report.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Service availability, host headroom, and workload pressure.</p>
        </div>
        <div className="flex items-center gap-1" aria-label="History range">
          {[24, 168].map((hours) => (
            <Link
              key={hours}
              href={`/settings/health?hours=${hours}`}
              className={cn(buttonVariants({ variant: historyHours === hours ? "secondary" : "ghost", size: "sm" }))}
            >
              {hours === 24 ? "24 hours" : "7 days"}
            </Link>
          ))}
        </div>
      </header>

      <section aria-labelledby="risks-heading" className="flex flex-col gap-3">
        <div>
          <h3 id="risks-heading" className="text-sm font-semibold">Current risks</h3>
          <p className="mt-1 text-xs text-muted-foreground">Issues that can interrupt deploys, traffic, or observation.</p>
        </div>
        {report.capacity.risks.length === 0 && componentRisks.length === 0 ? (
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>No current risks</AlertTitle>
            <AlertDescription>Components are reachable and sampled host capacity has sufficient headroom.</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-2">
            {report.capacity.risks.map((risk) => (
              <Alert key={risk.code} variant={risk.severity === "critical" ? "destructive" : "default"}>
                <AlertTriangleIcon />
                <AlertTitle>{risk.severity === "critical" ? "Critical capacity risk" : "Capacity warning"}</AlertTitle>
                <AlertDescription>{risk.message}</AlertDescription>
              </Alert>
            ))}
            {componentRisks.map((component) => (
              <Alert key={component.key} variant={component.status === "unavailable" ? "destructive" : "default"}>
                <AlertTriangleIcon />
                <AlertTitle>{component.label} {component.status}</AlertTitle>
                <AlertDescription>{component.message}</AlertDescription>
              </Alert>
            ))}
          </div>
        )}
      </section>

      <Separator />

      <section aria-labelledby="components-heading" className="flex flex-col gap-3">
        <div>
          <h3 id="components-heading" className="text-sm font-semibold">Components</h3>
          <p className="mt-1 text-xs text-muted-foreground">Current evidence from the control plane and runtime path.</p>
        </div>
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader><TableRow><TableHead>Component</TableHead><TableHead>Status</TableHead><TableHead>Evidence</TableHead><TableHead>Observed</TableHead></TableRow></TableHeader>
            <TableBody>
              {report.components.map((component) => (
                <TableRow key={component.key}>
                  <TableCell className="font-medium">{component.label}</TableCell>
                  <TableCell><HealthBadge status={component.status} /></TableCell>
                  <TableCell className="max-w-md text-muted-foreground">{component.message}</TableCell>
                  <TableCell className="text-muted-foreground">{component.observedAt ? new Date(component.observedAt).toLocaleString() : "No observation"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <Separator />

      <section aria-labelledby="capacity-heading" className="flex flex-col gap-4">
        <div>
          <h3 id="capacity-heading" className="text-sm font-semibold">Capacity</h3>
          <p className="mt-1 text-xs text-muted-foreground">Filesystem, memory, and CPU measurements published by the Worker host.</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-3">
          <CapacityProgress label="Data filesystem" value={report.capacity.disk.usedPercent ?? 0} displayValue={percentLabel(report.capacity.disk.usedPercent)} />
          <CapacityProgress label="Host memory" value={report.capacity.memory.usedPercent ?? 0} displayValue={percentLabel(report.capacity.memory.usedPercent)} />
          <CapacityProgress label="Host CPU" value={report.capacity.cpu.percent ?? 0} displayValue={report.capacity.cpu.percent === null ? "Collecting" : `${report.capacity.cpu.percent}%`} />
        </div>
        <div className="grid divide-y border-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="sm:pr-5">
            <CapacityTrend label="Disk used" value={percentLabel(report.capacity.disk.usedPercent)} values={diskValues} hours={historyHours} detail={`${formatBytes(report.capacity.disk.availableBytes)} available`} />
          </div>
          <div className="sm:px-5">
            <CapacityTrend label="Memory used" value={percentLabel(report.capacity.memory.usedPercent)} values={memoryValues} hours={historyHours} detail={`${formatBytes(report.capacity.memory.availableBytes)} available`} />
          </div>
          <div className="sm:pl-5">
            <CapacityTrend label="CPU" value={percentLabel(report.capacity.cpu.percent)} values={cpuValues} hours={historyHours} detail={`Load ${report.capacity.cpu.load1?.toFixed(2) ?? "—"}`} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {report.capacity.disk.projectedDaysRemaining === null
            ? "A disk exhaustion forecast appears after at least one day of measurable growth."
            : `At the recent growth rate, available disk is projected to last about ${report.capacity.disk.projectedDaysRemaining} days.`}
        </p>
      </section>

      <Separator />

      <section aria-labelledby="workload-heading" className="flex flex-col gap-3">
        <div>
          <h3 id="workload-heading" className="text-sm font-semibold">Workload</h3>
          <p className="mt-1 text-xs text-muted-foreground">Current queue pressure and RuntimeInstance lifecycle distribution.</p>
        </div>
        <dl className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4">
          <WorkloadValue label="Queued jobs" value={report.workload.queuedJobs} />
          <WorkloadValue label="Running jobs" value={report.workload.runningJobs} />
          <WorkloadValue label="Ready runtimes" value={report.workload.runtimeInstances.ready} />
          <WorkloadValue label="Starting runtimes" value={report.workload.runtimeInstances.starting} />
        </dl>
        <p className="text-xs text-muted-foreground">
          Oldest queued job: {report.workload.oldestQueuedAt ? new Date(report.workload.oldestQueuedAt).toLocaleString() : "None"}
          {latest ? ` · Latest host sample ${new Date(latest.observedAt).toLocaleString()}` : " · No host samples yet"}
        </p>
      </section>
    </div>
  );
}

function HealthBadge({ status }: { status: InstanceHealthStatus }) {
  return <Badge variant={status === "critical" || status === "unavailable" ? "destructive" : status === "warning" ? "secondary" : "outline"}>{status}</Badge>;
}

function WorkloadValue({ label, value }: { label: string; value: number }) {
  return <div className="bg-background p-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums">{value}</dd></div>;
}

function percentUsed(total: number, available: number): number {
  return total > 0 ? Math.round((1 - available / total) * 1000) / 10 : 0;
}

function percentLabel(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}
