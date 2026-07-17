"use client";

import { useState } from "react";
import { Settings2Icon } from "lucide-react";
import type { AgentAuthMethodDescriptor } from "@eveland/core/agent-auth";
import { AgentAuthFields } from "@/components/agent-auth-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { agentAuthValuesFromConfig, serializeAgentAuthConfig } from "@/lib/agent-auth-form";
import {
  getAgentAuthMethods,
  getProjectAgentConnection,
  updateAgentConnection,
  type AgentAuthStatus,
  type AgentConnectionView,
} from "@/lib/client-api";

export function AgentConnectionSettings({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState<AgentAuthMethodDescriptor[]>([]);
  const [connection, setConnection] = useState<AgentConnectionView | null>(null);
  const [status, setStatus] = useState<AgentAuthStatus | null>(null);
  const [method, setMethod] = useState("local-dev");
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextMethods, result] = await Promise.all([
        getAgentAuthMethods(),
        getProjectAgentConnection(projectId),
      ]);
      const descriptor = nextMethods.find((candidate) => candidate.method === result.connection.method);
      setMethods(nextMethods);
      setConnection(result.connection);
      setStatus(result.status);
      setMethod(result.connection.method);
      setValues(descriptor ? agentAuthValuesFromConfig(descriptor, result.connection.config) : {});
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection || saving) return;
    const descriptor = methods.find((candidate) => candidate.method === method);
    if (!descriptor) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateAgentConnection(connection.id, {
        expectedSecurityRevision: connection.securityRevision,
        method,
        config: serializeAgentAuthConfig(descriptor, values),
      });
      setConnection(result.connection);
      setStatus(result.status);
      setOpen(false);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void load();
      }}
    >
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <Settings2Icon data-icon="inline-start" />
        Connection
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent Connection</DialogTitle>
          <DialogDescription>
            Configure the credential Eveland sends to this Agent&apos;s Eve route. This is separate from your Eveland login.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Spinner /> Loading connection…</div>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Connection update failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {!loading && connection ? (
          <form className="flex flex-col gap-6" onSubmit={submit}>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Security revision {connection.securityRevision}</span>
              <Badge variant={status?.state === "misconfigured" ? "destructive" : "secondary"}>
                {statusLabel(status)}
              </Badge>
            </div>
            <AgentAuthFields
              methods={methods}
              method={method}
              values={values}
              onMethodChange={(nextMethod) => {
                setMethod(nextMethod);
                setValues({});
              }}
              onValuesChange={setValues}
            />
            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving ? <Spinner data-icon="inline-start" /> : <Settings2Icon data-icon="inline-start" />}
                {saving ? "Saving…" : "Save connection"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function statusLabel(status: AgentAuthStatus | null): string {
  if (!status) return "Unknown";
  if (status.state === "not_required") return "No credential";
  if (status.state === "credential_available") return "Credential ready";
  if (status.state === "interaction_required") return "Authorization required";
  return "Misconfigured";
}

function toMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Agent Connection request failed.";
}
