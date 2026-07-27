"use client";

import { useId, useState } from "react";
import { FingerprintIcon, Globe2Icon, KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import type { IdentityRealm, IdentityReturnTarget } from "@eveland/core/identity";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createInternalIdentityProvider,
  createInternalIdentityRealm,
  preflightIdentityProvider,
  setIdentityRealmProjectGrant,
  updateIdentityRealm,
  updateInternalIdentityProvider,
  upsertIdentityReturnTarget,
} from "@/lib/client-api";
import type {
  IdentityRealmGrant,
  PublicIdentityProvider,
} from "@/lib/server-api";

export function IdentitySettings({
  initialProviders,
  initialRealms,
  initialGrants,
  initialReturnTargets,
  projects,
}: {
  initialProviders: PublicIdentityProvider[];
  initialRealms: IdentityRealm[];
  initialGrants: IdentityRealmGrant[];
  initialReturnTargets: IdentityReturnTarget[];
  projects: Array<{ id: string; name: string }>;
}) {
  const providerNameId = useId();
  const realmKeyId = useId();
  const realmNameId = useId();
  const returnTargetOriginId = useId();
  const [providers, setProviders] = useState(initialProviders);
  const [realms, setRealms] = useState(initialRealms);
  const [grants, setGrants] = useState(initialGrants);
  const [returnTargets, setReturnTargets] = useState(initialReturnTargets);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const internalProvider = providers.find((provider) => provider.type === "internal");
  const internalRealm = internalProvider
    ? realms.find((realm) => realm.providerConnectionId === internalProvider.id)
    : undefined;

  async function run(label: string, action: () => Promise<void>) {
    setPending(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Identity settings could not be updated.");
    } finally {
      setPending(null);
    }
  }

  async function createProvider(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run("provider", async () => {
      const provider = await createInternalIdentityProvider({
        displayName: String(data.get("displayName") ?? ""),
        internalRealmKey: String(data.get("internalRealmKey") ?? ""),
        enabled: true,
      });
      setProviders((current) => [...current, provider]);
      setNotice("Eveland Internal is enabled. Add its allowed Identity Realm next.");
    });
  }

  async function toggleProvider(enabled: boolean) {
    if (!internalProvider?.internalRealmKey) return;
    await run("provider-toggle", async () => {
      const provider = await updateInternalIdentityProvider({
        id: internalProvider.id,
        expectedSecurityRevision: internalProvider.securityRevision,
        displayName: internalProvider.displayName,
        internalRealmKey: internalProvider.internalRealmKey!,
        enabled,
      });
      setProviders((current) =>
        current.map((candidate) => candidate.id === provider.id ? provider : candidate),
      );
      setNotice(enabled ? "Identity Provider enabled." : "Identity Provider disabled.");
    });
  }

  async function preflight() {
    if (!internalProvider) return;
    await run("preflight", async () => {
      const result = await preflightIdentityProvider(internalProvider.id);
      if (!result.ok) throw new Error("Internal Identity preflight did not pass.");
      setNotice("Internal Identity preflight passed.");
    });
  }

  async function createRealm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!internalProvider?.internalRealmKey) return;
    const data = new FormData(event.currentTarget);
    await run("realm", async () => {
      const realm = await createInternalIdentityRealm({
        providerConnectionId: internalProvider.id,
        externalRealmId: internalProvider.internalRealmKey!,
        displayName: String(data.get("displayName") ?? ""),
        enabled: true,
      });
      setRealms((current) => [...current, realm]);
      setNotice("Identity Realm enabled. Grant only the Projects this scope may use.");
    });
  }

  async function toggleRealm(enabled: boolean) {
    if (!internalRealm) return;
    await run("realm-toggle", async () => {
      const realm = await updateIdentityRealm({
        id: internalRealm.id,
        displayName: internalRealm.displayName,
        enabled,
      });
      setRealms((current) =>
        current.map((candidate) => candidate.id === realm.id ? realm : candidate),
      );
      setNotice(enabled ? "Identity Realm enabled." : "Identity Realm disabled.");
    });
  }

  async function toggleGrant(projectId: string, granted: boolean) {
    if (!internalRealm) return;
    await run(`grant:${projectId}`, async () => {
      const grant = await setIdentityRealmProjectGrant(
        internalRealm.id,
        projectId,
        granted,
      );
      setGrants((current) => [
        ...current.filter(
          (candidate) =>
            candidate.identityRealmId !== internalRealm.id ||
            candidate.projectId !== projectId,
        ),
        ...(grant ? [grant] : []),
      ]);
      setNotice(granted ? "Project access granted." : "Project access revoked.");
    });
  }

  async function saveReturnTarget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run("return-target", async () => {
      const target = await upsertIdentityReturnTarget({
        key: "eve-chats",
        origin: String(data.get("origin") ?? ""),
        enabled: data.get("enabled") === "on",
      });
      setReturnTargets((current) => [
        ...current.filter((candidate) => candidate.key !== target.key),
        target,
      ]);
      setNotice("EveChats return target saved.");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Web chat return target</CardTitle>
          <CardDescription>
            Eveland redirects only to this exact EveChats origin after a successful identity login.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveReturnTarget}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={returnTargetOriginId}>EveChats origin</FieldLabel>
                <Input
                  id={returnTargetOriginId}
                  name="origin"
                  type="url"
                  placeholder="https://chat.example.com"
                  defaultValue={
                    returnTargets.find((target) => target.key === "eve-chats")?.origin ?? ""
                  }
                  required
                  disabled={pending !== null}
                />
                <FieldDescription>
                  Exact HTTP(S) origin only—no path, query, wildcard, or provider-specific callback.
                </FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <Switch
                  id="identity-return-target-enabled"
                  name="enabled"
                  defaultChecked={
                    returnTargets.find((target) => target.key === "eve-chats")?.enabled ?? true
                  }
                  disabled={pending !== null}
                />
                <FieldContent>
                  <FieldLabel htmlFor="identity-return-target-enabled">
                    Allow EveChats login returns
                  </FieldLabel>
                </FieldContent>
              </Field>
              <Field>
                <Button type="submit" disabled={pending !== null}>
                  {pending === "return-target" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Globe2Icon data-icon="inline-start" />
                  )}
                  {pending === "return-target" ? "Saving…" : "Save return target"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Identity Provider</CardTitle>
          <CardDescription>
            Eveland Internal maps a verified control-plane login into a separate Agent-user identity session.
          </CardDescription>
          {internalProvider ? (
            <CardAction className="flex items-center gap-3">
              <Badge variant={internalProvider.enabled ? "default" : "secondary"}>
                {internalProvider.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Switch
                aria-label="Enable Eveland Internal"
                checked={internalProvider.enabled}
                onCheckedChange={toggleProvider}
                disabled={pending !== null}
              />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {internalProvider ? (
            <div className="flex flex-col gap-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{internalProvider.displayName}</span>
                  <span className="text-sm text-muted-foreground">Provider type · Internal</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Internal Realm key</span>
                  <code className="text-sm text-muted-foreground">
                    {internalProvider.internalRealmKey}
                  </code>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={preflight}
                disabled={pending !== null}
              >
                {pending === "preflight" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ShieldCheckIcon data-icon="inline-start" />
                )}
                {pending === "preflight" ? "Running preflight…" : "Run preflight"}
              </Button>
            </div>
          ) : (
            <form onSubmit={createProvider}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={providerNameId}>Display name</FieldLabel>
                  <Input
                    id={providerNameId}
                    name="displayName"
                    defaultValue="Eveland Internal"
                    required
                    disabled={pending !== null}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={realmKeyId}>Internal Realm key</FieldLabel>
                  <Input
                    id={realmKeyId}
                    name="internalRealmKey"
                    placeholder="eveland-members"
                    required
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending !== null}
                  />
                  <FieldDescription>
                    Stable and immutable after creation. It is not a Team membership ID or email domain.
                  </FieldDescription>
                </Field>
                <Field>
                  <Button type="submit" disabled={pending !== null}>
                    {pending === "provider" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <KeyRoundIcon data-icon="inline-start" />
                    )}
                    {pending === "provider" ? "Creating…" : "Create Internal provider"}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Identity Realm</CardTitle>
          <CardDescription>
            The Realm is the internal authorization and data-isolation boundary used by Agents.
          </CardDescription>
          {internalRealm ? (
            <CardAction className="flex items-center gap-3">
              <Badge variant={internalRealm.enabled ? "default" : "secondary"}>
                {internalRealm.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Switch
                aria-label="Enable Identity Realm"
                checked={internalRealm.enabled}
                onCheckedChange={toggleRealm}
                disabled={pending !== null}
              />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {!internalProvider ? (
            <Alert>
              <FingerprintIcon />
              <AlertDescription>
                Create the Internal Identity Provider before adding its Realm.
              </AlertDescription>
            </Alert>
          ) : internalRealm ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{internalRealm.displayName}</span>
                <code className="text-sm text-muted-foreground">{internalRealm.id}</code>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">External Realm ID</span>
                <code className="text-sm text-muted-foreground">
                  {internalRealm.externalRealmId}
                </code>
              </div>
            </div>
          ) : (
            <form onSubmit={createRealm}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={realmNameId}>Realm display name</FieldLabel>
                  <Input
                    id={realmNameId}
                    name="displayName"
                    defaultValue="Eveland Members"
                    required
                    disabled={pending !== null}
                  />
                  <FieldDescription>
                    The external ID is fixed to {internalProvider.internalRealmKey}.
                  </FieldDescription>
                </Field>
                <Field>
                  <Button type="submit" disabled={pending !== null}>
                    {pending === "realm" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <FingerprintIcon data-icon="inline-start" />
                    )}
                    {pending === "realm" ? "Creating…" : "Create Identity Realm"}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Project access</CardTitle>
          <CardDescription>
            Caller Tokens are issued only when this Realm has an explicit grant to the target Project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Project ID</TableHead>
                  <TableHead className="w-32 text-right">Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => {
                  const granted = Boolean(
                    internalRealm &&
                      grants.some(
                        (grant) =>
                          grant.identityRealmId === internalRealm.id &&
                          grant.projectId === project.id,
                      ),
                  );
                  const grantPending = pending === `grant:${project.id}`;
                  return (
                    <TableRow key={project.id}>
                      <TableCell className="font-medium">{project.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {project.id}
                      </TableCell>
                      <TableCell>
                        <Field orientation="horizontal" data-disabled={!internalRealm}>
                          <FieldContent>
                            <FieldTitle className="sr-only">
                              Access to {project.name}
                            </FieldTitle>
                          </FieldContent>
                          <Switch
                            aria-label={`Allow ${project.name}`}
                            checked={granted}
                            onCheckedChange={(checked) =>
                              toggleGrant(project.id, checked)
                            }
                            disabled={!internalRealm || pending !== null}
                          />
                          {grantPending ? <Spinner /> : null}
                        </Field>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
