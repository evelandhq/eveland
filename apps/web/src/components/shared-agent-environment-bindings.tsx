"use client";

import { useMemo, useState } from "react";
import { LinkIcon, Trash2Icon } from "lucide-react";
import type { SharedAgentEnvironment, SharedAgentEnvironmentBinding } from "@eveland/core/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { bindSharedAgentEnvironment, unbindSharedAgentEnvironment } from "@/lib/client-api";

type DeploymentOption = { id: string; label: string };

export function SharedAgentEnvironmentBindings({
  projectId,
  environment,
  initialBindings,
  deployments,
  canManage,
}: {
  projectId: string;
  environment: SharedAgentEnvironment | null;
  initialBindings: SharedAgentEnvironmentBinding[];
  deployments: DeploymentOption[];
  canManage: boolean;
}) {
  const [bindings, setBindings] = useState(initialBindings);
  const [target, setTarget] = useState("project");
  const [pending, setPending] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const targetItems = useMemo(() => [
    { label: "Project default", value: "project" },
    ...deployments.map((deployment) => ({ label: deployment.label, value: `deployment:${deployment.id}` })),
  ], [deployments]);

  async function bind() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const deploymentId = target.startsWith("deployment:") ? target.slice("deployment:".length) : null;
      const result = await bindSharedAgentEnvironment({ projectId, deploymentId });
      setBindings((current) => [
        result.binding,
        ...current.filter((binding) => binding.deploymentId !== result.binding.deploymentId),
      ]);
      setNotice(result.jobs.length > 0
        ? `Binding saved. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
        : "Binding saved. It will apply the next time the target process starts.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the shared environment binding.");
    } finally {
      setPending(false);
    }
  }

  async function unbind(bindingId: string) {
    setRemovingId(bindingId);
    setError(null);
    setNotice(null);
    try {
      const result = await unbindSharedAgentEnvironment(projectId, bindingId);
      if (result.deleted) setBindings((current) => current.filter((binding) => binding.id !== bindingId));
      setNotice(result.jobs.length > 0
        ? `Binding removed. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
        : "Binding removed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the shared environment binding.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shared environment bindings</CardTitle>
        <CardDescription>
          Explicitly grant this Project or one Deployment access to the system shared Agent environment.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {canManage ? (
          environment && environment.entries.length > 0 ? (
            <FieldGroup>
              <Field>
                <FieldLabel>Target</FieldLabel>
                <Select items={targetItems} value={target} onValueChange={(value) => value && setTarget(value)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {targetItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>Choose Project default for every Deployment, or bind one Deployment without enabling the whole Project.</FieldDescription>
              </Field>
              <Button type="button" disabled={pending} onClick={() => void bind()}>
                {pending ? <Spinner data-icon="inline-start" /> : <LinkIcon data-icon="inline-start" />}
                Save binding
              </Button>
            </FieldGroup>
          ) : (
            <Alert><AlertDescription>Configure the shared Agent environment in System settings before adding a binding.</AlertDescription></Alert>
          )
        ) : null}

        {bindings.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><LinkIcon /></EmptyMedia>
              <EmptyTitle>No shared environment binding</EmptyTitle>
              <EmptyDescription>This Project currently uses only its own Secrets and Eveland-reserved values.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Revision</TableHead>
                {canManage ? <TableHead><span className="sr-only">Actions</span></TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.map((binding) => (
                <TableRow key={binding.id}>
                  <TableCell><Badge variant="secondary">{binding.deploymentId ? "Deployment" : "Project"}</Badge></TableCell>
                  <TableCell>{binding.deploymentId ?? "Project default"}</TableCell>
                  <TableCell>r{binding.environmentRevision}</TableCell>
                  {canManage ? (
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={removingId === binding.id}
                        onClick={() => void unbind(binding.id)}
                      >
                        {removingId === binding.id
                          ? <Spinner data-icon="inline-start" />
                          : <Trash2Icon data-icon="inline-start" />}
                        Remove
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
