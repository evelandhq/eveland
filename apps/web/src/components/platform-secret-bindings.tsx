"use client";

import { useMemo, useState } from "react";
import { LinkIcon, Trash2Icon } from "lucide-react";
import type {
  PlatformSecretConsumer,
  PlatformSecretProfile,
  PlatformSecretProfileBinding,
} from "@eveland/core/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { bindPlatformSecretProfile, unbindPlatformSecretProfile } from "@/lib/client-api";

type DeploymentOption = { id: string; label: string };

const consumerItems = [
  { label: "Agent runtime", value: "agent-runtime" },
  { label: "Agent Connection", value: "agent-connection" },
] as const;

export function PlatformSecretBindings({
  projectId,
  initialBindings,
  profiles,
  deployments,
  canManage,
}: {
  projectId: string;
  initialBindings: PlatformSecretProfileBinding[];
  profiles: PlatformSecretProfile[];
  deployments: DeploymentOption[];
  canManage: boolean;
}) {
  const [bindings, setBindings] = useState(initialBindings);
  const [profileId, setProfileId] = useState<string | null>(profiles[0]?.id ?? null);
  const [consumer, setConsumer] = useState<PlatformSecretConsumer>("agent-runtime");
  const [target, setTarget] = useState("project");
  const [pending, setPending] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const profileItems = useMemo(() => [
    { label: "Select a profile", value: null },
    ...profiles.map((profile) => ({ label: `${profile.name} · r${profile.revision}`, value: profile.id })),
  ], [profiles]);
  const targetItems = useMemo(() => [
    { label: "Project default", value: "project" },
    ...deployments.map((deployment) => ({ label: deployment.label, value: `deployment:${deployment.id}` })),
  ], [deployments]);

  async function bind() {
    if (!profileId) {
      setError("Select a Secret Profile.");
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const deploymentId = target.startsWith("deployment:") ? target.slice("deployment:".length) : null;
      const result = await bindPlatformSecretProfile({ projectId, profileId, deploymentId, consumer });
      setBindings((current) => [
        result.binding,
        ...current.filter((binding) => !(
          binding.consumer === result.binding.consumer && binding.deploymentId === result.binding.deploymentId
        )),
      ]);
      setNotice(result.jobs.length > 0
        ? `Binding saved. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
        : "Binding saved. Agent Connection requests resolve the current Profile revision immediately.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the Profile binding.");
    } finally {
      setPending(false);
    }
  }

  async function unbind(bindingId: string) {
    setRemovingId(bindingId);
    setError(null);
    setNotice(null);
    try {
      const result = await unbindPlatformSecretProfile(projectId, bindingId);
      if (result.deleted) setBindings((current) => current.filter((binding) => binding.id !== bindingId));
      setNotice(result.jobs.length > 0
        ? `Binding removed. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
        : "Binding removed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the Profile binding.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform Secret Profile bindings</CardTitle>
        <CardDescription>
          Runtime bindings inject values only when a process starts. Agent Connection bindings resolve values per request.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {canManage ? (
          profiles.length > 0 ? (
            <FieldGroup>
              <div className="grid gap-4 lg:grid-cols-3">
                <Field>
                  <FieldLabel>Profile</FieldLabel>
                  <Select items={profileItems} value={profileId} onValueChange={setProfileId}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {profileItems.map((item) => <SelectItem key={item.value ?? "placeholder"} value={item.value}>{item.label}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>Consumer</FieldLabel>
                  <Select
                    items={consumerItems}
                    value={consumer}
                    onValueChange={(value) => {
                      if (value === "agent-runtime" || value === "agent-connection") setConsumer(value);
                    }}
                  >
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {consumerItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>Agent Connection bindings are Project-scoped.</FieldDescription>
                </Field>
                <Field data-disabled={consumer === "agent-connection"}>
                  <FieldLabel>Target</FieldLabel>
                  <Select
                    items={targetItems}
                    value={consumer === "agent-connection" ? "project" : target}
                    disabled={consumer === "agent-connection"}
                    onValueChange={(value) => {
                      if (value) setTarget(value);
                    }}
                  >
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {targetItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Button type="button" disabled={pending || !profileId} onClick={() => void bind()}>
                {pending ? <Spinner data-icon="inline-start" /> : <LinkIcon data-icon="inline-start" />}
                Save binding
              </Button>
            </FieldGroup>
          ) : (
            <Alert><AlertDescription>Create a Secret Profile in System settings before adding a binding.</AlertDescription></Alert>
          )
        ) : null}

        {bindings.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><LinkIcon /></EmptyMedia>
              <EmptyTitle>No platform bindings</EmptyTitle>
              <EmptyDescription>This Project currently uses only its own Secrets and Eveland-reserved runtime values.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Profile</TableHead>
                <TableHead>Consumer</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Revision</TableHead>
                {canManage ? <TableHead><span className="sr-only">Actions</span></TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.map((binding) => (
                <TableRow key={binding.id}>
                  <TableCell className="font-medium">{binding.profileName}</TableCell>
                  <TableCell><Badge variant="secondary">{binding.consumer}</Badge></TableCell>
                  <TableCell>{binding.deploymentId ? `Deployment ${binding.deploymentId}` : "Project default"}</TableCell>
                  <TableCell>r{binding.profileRevision}</TableCell>
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
