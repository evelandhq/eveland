"use client";

import { useId, useState } from "react";
import {
  CheckIcon,
  FingerprintIcon,
  Globe2Icon,
  KeyRoundIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type {
  IdentityProviderType,
  IdentityRealm,
  IdentityReturnTarget,
} from "@eveland/core/identity";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  createInternalIdentityProvider,
  createInternalIdentityRealm,
  createOpenIdentityProvider,
  preflightIdentityProvider,
  setIdentityProviderEnabled,
  updateIdentityRealm,
  upsertIdentityReturnTarget,
} from "@/lib/client-api";
import type { PublicIdentityProvider } from "@/lib/api";
import { cn } from "@/lib/utils";

export function IdentitySettings({
  initialProviders,
  initialRealms,
  initialReturnTargets,
}: {
  initialProviders: PublicIdentityProvider[];
  initialRealms: IdentityRealm[];
  initialReturnTargets: IdentityReturnTarget[];
}) {
  const providerNameId = useId();
  const realmKeyId = useId();
  const realmNameId = useId();
  const returnTargetOriginId = useId();
  const [providers, setProviders] = useState(initialProviders);
  const [realms, setRealms] = useState(initialRealms);
  const [returnTargets, setReturnTargets] = useState(initialReturnTargets);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<IdentityProviderType | null>(null);

  const openProvider = providers.find((provider) => provider.type === "open");
  const internalProvider = providers.find((provider) => provider.type === "internal");
  const activeProvider = providers.find((provider) => provider.enabled);
  const activeType = activeProvider?.type ?? null;
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
      setError(
        caught instanceof Error ? caught.message : "Identity settings could not be updated.",
      );
    } finally {
      setPending(null);
    }
  }

  function replaceProviders(...updated: PublicIdentityProvider[]) {
    setProviders((current) => {
      const next = current.map(
        (candidate) => updated.find((provider) => provider.id === candidate.id) ?? candidate,
      );
      return [...next, ...updated.filter((provider) => !next.some((c) => c.id === provider.id))];
    });
  }

  /**
   * Creates the Internal Provider disabled, so a failure here leaves the
   * platform on whatever Provider it was already using rather than stranding
   * it with none enabled.
   */
  async function createProvider(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run("provider", async () => {
      const provider = await createInternalIdentityProvider({
        displayName: String(data.get("displayName") ?? ""),
        internalRealmKey: String(data.get("internalRealmKey") ?? ""),
        enabled: false,
      });
      replaceProviders(provider);
      setNotice(
        "Eveland Internal is configured. Add its allowed Identity Realm, then select it below.",
      );
    });
  }

  /**
   * Switches the platform Identity Provider. Exactly one may be enabled, so
   * the outgoing one is disabled first; if enabling the replacement then
   * fails, the previous Provider is restored rather than left off.
   */
  async function selectProvider(type: IdentityProviderType) {
    setConfirming(null);
    if (type === activeType) return;
    await run(`select-${type}`, async () => {
      let target = type === "open" ? openProvider : internalProvider;
      if (type === "open" && !target) {
        target = await createOpenIdentityProvider({ displayName: "Open for all", enabled: false });
        replaceProviders(target);
      }
      if (!target) throw new Error("Configure this Identity Provider before selecting it.");

      const previous = activeProvider;
      const disabled = previous
        ? await setIdentityProviderEnabled({
            id: previous.id,
            expectedSecurityRevision: previous.securityRevision,
            displayName: previous.displayName,
            enabled: false,
          })
        : undefined;
      try {
        const enabled = await setIdentityProviderEnabled({
          id: target.id,
          expectedSecurityRevision: target.securityRevision,
          displayName: target.displayName,
          enabled: true,
        });
        replaceProviders(...(disabled ? [disabled, enabled] : [enabled]));
      } catch (caught) {
        if (disabled) {
          replaceProviders(
            await setIdentityProviderEnabled({
              id: disabled.id,
              expectedSecurityRevision: disabled.securityRevision,
              displayName: disabled.displayName,
              enabled: true,
            }),
          );
        }
        throw caught;
      }
      setNotice(
        type === "open"
          ? "Eveland is now open to all callers. Existing identity sessions no longer authenticate anyone."
          : "Eveland Internal is now the Identity Provider. Existing identity sessions were invalidated.",
      );
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
      setNotice("Identity Realm enabled.");
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
        current.map((candidate) => (candidate.id === realm.id ? realm : candidate)),
      );
      setNotice(enabled ? "Identity Realm enabled." : "Identity Realm disabled.");
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
            One Identity Provider serves the whole instance. It decides who Eveland will vouch for
            when an Agent asks; it does not decide which Agents are reachable.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <ProviderOption
              title="Open for all"
              description="Eveland authenticates nobody. Every caller shares one identity, and Agents that ask for an Eveland identity accept them all."
              selected={activeType === "open"}
              pending={pending === "select-open"}
              disabled={pending !== null}
              onSelect={() => setConfirming("open")}
            />
            <ProviderOption
              title="Eveland Internal"
              description="Maps a verified control-plane login into a separate Agent-user identity session."
              selected={activeType === "internal"}
              pending={pending === "select-internal"}
              disabled={pending !== null || !internalProvider}
              hint={internalProvider ? undefined : "Configure it below first"}
              onSelect={() => setConfirming("internal")}
            />
            <ProviderOption
              title="OIDC"
              description="Delegate identity to your own OpenID Connect provider."
              selected={false}
              pending={false}
              disabled
              hint="Coming soon"
              onSelect={() => {}}
            />
          </div>

          {internalProvider ? (
            <div className="flex flex-col gap-5 border-t pt-6">
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
            <form onSubmit={createProvider} className="border-t pt-6">
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
                    Stable and immutable after creation. It is not a Team membership ID or email
                    domain.
                  </FieldDescription>
                </Field>
                <Field>
                  <Button type="submit" disabled={pending !== null}>
                    {pending === "provider" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <KeyRoundIcon data-icon="inline-start" />
                    )}
                    {pending === "provider" ? "Creating…" : "Configure Eveland Internal"}
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "open"
                ? "Open this instance to all callers?"
                : "Switch to Eveland Internal?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every identity session issued by the current Identity Provider stops authenticating
              anyone, and users signed in through it have to sign in again.
              {confirming === "open"
                ? " Agents that rely on an Eveland identity will accept every caller."
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && void selectProvider(confirming)}>
              Switch Identity Provider
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  );
}

function ProviderOption({
  title,
  description,
  hint,
  selected,
  pending,
  disabled,
  onSelect,
}: {
  title: string;
  description: string;
  hint?: string;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled || selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4 text-left transition-colors",
        selected ? "border-primary bg-accent/40" : "hover:bg-accent/30",
        disabled && !selected ? "opacity-60" : null,
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center pt-0.5">
        {pending ? <Spinner /> : selected ? <CheckIcon className="size-4 text-primary" /> : null}
      </span>
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {selected ? <Badge>Active</Badge> : null}
          {hint ? <Badge variant="secondary">{hint}</Badge> : null}
        </span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
