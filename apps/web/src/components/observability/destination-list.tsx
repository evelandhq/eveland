"use client";

import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  destinationKindLabel,
  type ObservabilityDestination,
} from "./destination-draft";

export function ObservabilityDestinationList({
  destinations,
  pending,
  error,
  onCreate,
  onEdit,
  onToggle,
  onDelete,
}: {
  destinations: ObservabilityDestination[];
  pending: boolean;
  error: string | null;
  onCreate: () => void;
  onEdit: (destination: ObservabilityDestination) => void;
  onToggle: (destinationId: string, enabled: boolean) => void;
  onDelete: (destinationId: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>External destinations</CardTitle>
        <CardDescription>
          Forward Eveland telemetry through the managed OpenTelemetry
          Collector. Elastic receives every signal and domain; Langfuse
          receives Agent traces only.
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            size="sm"
            onClick={onCreate}
            disabled={pending}
          >
            <PlusIcon data-icon="inline-start" />
            Add destination
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {destinations.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No external destination is configured. Until one is added, span,
            log, and metric detail is not retained anywhere.
          </div>
        ) : (
          destinations.map((destination) => (
            <DestinationRow
              key={destination.id}
              destination={destination}
              pending={pending}
              onEdit={onEdit}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))
        )}
        <p className="text-xs text-muted-foreground">
          Credentials are encrypted at rest and are never returned to the
          browser after saving. Changes are applied without restarting Agent
          Deployments.
        </p>
      </CardContent>
    </Card>
  );
}

function DestinationRow({
  destination,
  pending,
  onEdit,
  onToggle,
  onDelete,
}: {
  destination: ObservabilityDestination;
  pending: boolean;
  onEdit: (destination: ObservabilityDestination) => void;
  onToggle: (destinationId: string, enabled: boolean) => void;
  onDelete: (destinationId: string) => void;
}) {
  const label = destinationKindLabel(destination.kind);
  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label}</span>
          <Badge variant={destination.enabled ? "secondary" : "outline"}>
            {destination.enabled ? "Enabled" : "Paused"}
          </Badge>
          <Badge
            variant={
              destination.health.status === "degraded"
                ? "destructive"
                : "outline"
            }
          >
            {destination.health.status === "pending"
              ? "Probe pending"
              : destination.health.status === "healthy"
                ? "Healthy"
                : destination.health.status === "degraded"
                  ? "Degraded"
                  : "Probe paused"}
          </Badge>
        </div>
        <DestinationEndpoint destination={destination} />
        <div className="flex flex-wrap gap-1.5">
          {destination.supportedSignals.map((signal) => (
            <Badge key={signal} variant="outline">
              {signal}
            </Badge>
          ))}
          {"domains" in destination
            ? destination.domains.map((domain) => (
                <Badge key={domain} variant="outline">
                  {domain}
                </Badge>
              ))
            : null}
          {destination.kind === "langfuse" ? (
            <Badge variant="outline">agent</Badge>
          ) : null}
        </div>
        {destination.health.lastError ? (
          <p className="text-xs text-destructive">
            {destination.health.lastError}
          </p>
        ) : destination.health.checkedAt ? (
          <p className="text-xs text-muted-foreground">
            Last checked <DateTime value={destination.health.checkedAt} />
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${label}`}
          disabled={pending}
          onClick={() => onEdit(destination)}
        >
          <PencilIcon />
        </Button>
        <Switch
          aria-label={`Enable ${label}`}
          checked={destination.enabled}
          disabled={pending}
          onCheckedChange={(enabled) => onToggle(destination.id, enabled)}
        />
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${label}`}
                disabled={pending}
              />
            }
          >
            <Trash2Icon />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
              <AlertDialogDescription>
                Eveland will stop forwarding telemetry to this destination and
                its stored credentials are deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete(destination.id)}>
                Remove destination
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function DestinationEndpoint({
  destination,
}: {
  destination: ObservabilityDestination;
}) {
  if (!destination.config) {
    return (
      <p className="text-xs text-destructive">
        The stored configuration cannot be read with the current
        APP_SECRET_KEY. Edit the destination to replace it.
      </p>
    );
  }
  return (
    <span className="break-all font-mono text-xs">
      {destination.config.kind === "langfuse"
        ? destination.config.baseUrl
        : destination.config.endpoint}
    </span>
  );
}
