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
  ExternalRealmKind,
  IdentityProviderType,
  IdentityRealm,
  IdentityReturnTarget,
} from "@evelandhq/core/identity";
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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  createInternalIdentityProvider,
  createInternalIdentityRealm,
  createOidcIdentityProvider,
  createOidcIdentityRealm,
  createOpenIdentityProvider,
  preflightIdentityProvider,
  setIdentityProviderEnabled,
  updateIdentityRealm,
  updateOidcIdentityProvider,
  upsertIdentityReturnTarget,
  type OidcIdentityProviderConfigInput,
} from "@/lib/client-api";
import type { PublicIdentityProvider } from "@/lib/api";
import { cn } from "@/lib/utils";

export function IdentitySettings({
  initialProviders,
  initialRealms,
  initialReturnTargets,
  oidcRedirectUri,
}: {
  initialProviders: PublicIdentityProvider[];
  initialRealms: IdentityRealm[];
  initialReturnTargets: IdentityReturnTarget[];
  oidcRedirectUri?: string;
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
  const oidcProvider = providers.find((provider) => provider.type === "oidc");
  const activeProvider = providers.find((provider) => provider.enabled);
  const activeType = activeProvider?.type ?? null;
  const internalRealm = internalProvider
    ? realms.find((realm) => realm.providerConnectionId === internalProvider.id)
    : undefined;
  const oidcRealms = oidcProvider
    ? realms.filter((realm) => realm.providerConnectionId === oidcProvider.id)
    : [];

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
      let target =
        type === "open" ? openProvider : type === "internal" ? internalProvider : oidcProvider;
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
          : type === "internal"
            ? "Eveland Internal is now the Identity Provider. Existing identity sessions were invalidated."
            : "OIDC is now the Identity Provider. Existing identity sessions were invalidated, and callers sign in at your IdP.",
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

  async function saveOidcProvider(input: OidcIdentityProviderConfigInput) {
    await run("oidc-provider", async () => {
      if (oidcProvider) {
        const updated = await updateOidcIdentityProvider({
          id: oidcProvider.id,
          expectedSecurityRevision: oidcProvider.securityRevision,
          enabled: oidcProvider.enabled,
          ...input,
        });
        replaceProviders(updated);
        setNotice(
          `OIDC Provider updated with ${describeOidcResolution(updated)}. A security-relevant change signs existing OIDC users out.`,
        );
      } else {
        const created = await createOidcIdentityProvider({ ...input, enabled: false });
        replaceProviders(created);
        setNotice(
          `OIDC Provider configured with ${describeOidcResolution(created)}. Register the redirect URI at your IdP, add an allowed Realm, run the preflight, then select OIDC above.`,
        );
      }
    });
  }

  async function preflightOidc() {
    if (!oidcProvider) return;
    await run("preflight-oidc", async () => {
      const result = await preflightIdentityProvider(oidcProvider.id);
      if (!result.ok) {
        const failing = Object.entries(result.checks ?? {})
          .filter(([, ok]) => !ok)
          .map(([check]) => check);
        throw new Error(
          result.error ?? `OIDC preflight failed: ${failing.join(", ") || "unknown check"}.`,
        );
      }
      const advisories = Object.entries(result.advisories ?? {})
        .filter(([, ok]) => !ok)
        .map(([advisory]) => advisory);
      setNotice(
        advisories.length > 0
          ? `OIDC preflight passed. The IdP does not advertise ${advisories.join(", ")}; verify those against its documentation.`
          : "OIDC preflight passed.",
      );
    });
  }

  async function createOidcRealm(input: {
    externalRealmId: string;
    externalRealmKind: Exclude<ExternalRealmKind, "internal">;
    displayName: string;
  }) {
    if (!oidcProvider) return;
    await run("oidc-realm", async () => {
      const realm = await createOidcIdentityRealm({
        providerConnectionId: oidcProvider.id,
        enabled: true,
        ...input,
      });
      setRealms((current) => [...current, realm]);
      setNotice("Identity Realm allowed. Logins resolving to it are now accepted.");
    });
  }

  async function toggleOidcRealm(realm: IdentityRealm, enabled: boolean) {
    await run(`oidc-realm-${realm.id}`, async () => {
      const updated = await updateIdentityRealm({
        id: realm.id,
        displayName: realm.displayName,
        enabled,
      });
      setRealms((current) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
      setNotice(enabled ? "Identity Realm enabled." : "Identity Realm disabled.");
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
                <Button type="submit" className="rounded-full" disabled={pending !== null}>
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
              description="Maps a verified Dashboard login into a separate Agent-user identity session."
              selected={activeType === "internal"}
              pending={pending === "select-internal"}
              disabled={pending !== null || !internalProvider}
              hint={internalProvider ? undefined : "Configure it below first"}
              onSelect={() => setConfirming("internal")}
            />
            <ProviderOption
              title="OIDC"
              description="Delegate identity to your own OpenID Connect provider."
              selected={activeType === "oidc"}
              pending={pending === "select-oidc"}
              disabled={pending !== null || !oidcProvider}
              hint={oidcProvider ? undefined : "Configure it below first"}
              onSelect={() => setConfirming("oidc")}
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
                  <Button type="submit" className="rounded-full" disabled={pending !== null}>
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

      <OidcProviderCard
        provider={oidcProvider}
        oidcRedirectUri={oidcRedirectUri}
        pending={pending}
        onSave={saveOidcProvider}
        onPreflight={preflightOidc}
      />

      {oidcProvider ? (
        <OidcRealmsCard
          provider={oidcProvider}
          realms={oidcRealms}
          pending={pending}
          onCreate={createOidcRealm}
          onToggle={toggleOidcRealm}
        />
      ) : null}

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
                : confirming === "internal"
                  ? "Switch to Eveland Internal?"
                  : "Switch to OIDC?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every identity session issued by the current Identity Provider stops authenticating
              anyone, and users signed in through it have to sign in again.
              {confirming === "open"
                ? " Agents that rely on an Eveland identity will accept every caller."
                : confirming === "oidc"
                  ? " Callers sign in at your IdP, and the Playground's Eveland Identity credential becomes unavailable while OIDC is active."
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
                  <Button type="submit" className="rounded-full" disabled={pending !== null}>
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

const OIDC_REALM_KINDS = [
  "account",
  "organization",
  "tenant",
  "workspace",
  "corp",
  "enterprise",
] as const satisfies readonly Exclude<ExternalRealmKind, "internal" | "open_shared">[];

const OIDC_RESOLUTIONS = [
  {
    value: "id_token_claim",
    label: "ID token claim",
    description: "Read the Realm from a claim in the verified ID token (e.g. 金数据's account_id).",
  },
  {
    value: "userinfo_claim",
    label: "UserInfo claim",
    description: "Read the Realm from a claim in the UserInfo response.",
  },
  {
    value: "connection",
    label: "Whole connection",
    description: "Every login shares this connection's single enabled Realm.",
  },
] as const;

/**
 * Echoes the stored resolution back from the server response rather than the
 * submitted form, so a save that did not apply the mode the administrator
 * expected is visible in the notice instead of surfacing later as failed
 * logins.
 */
function describeOidcResolution(
  provider: Pick<PublicIdentityProvider, "externalRealmResolution" | "externalRealmClaim">,
) {
  const label =
    OIDC_RESOLUTIONS.find((candidate) => candidate.value === provider.externalRealmResolution)
      ?.label ?? provider.externalRealmResolution;
  return provider.externalRealmResolution === "connection"
    ? `Realm resolution “${label}”`
    : `Realm resolution “${label}” reading the “${provider.externalRealmClaim}” claim`;
}

function OidcProviderCard({
  provider,
  oidcRedirectUri,
  pending,
  onSave,
  onPreflight,
}: {
  provider?: PublicIdentityProvider;
  oidcRedirectUri?: string;
  pending: string | null;
  onSave: (input: OidcIdentityProviderConfigInput) => Promise<void>;
  onPreflight: () => Promise<void>;
}) {
  const nameId = useId();
  const issuerId = useId();
  const clientIdId = useId();
  const secretId = useId();
  const scopesId = useId();
  const claimId = useId();
  const [resolution, setResolution] = useState<
    OidcIdentityProviderConfigInput["externalRealmResolution"]
  >(
    provider?.externalRealmResolution === "connection" ||
      provider?.externalRealmResolution === "id_token_claim" ||
      provider?.externalRealmResolution === "userinfo_claim"
      ? provider.externalRealmResolution
      : "id_token_claim",
  );
  const [authMethod, setAuthMethod] = useState<
    OidcIdentityProviderConfigInput["tokenEndpointAuthMethod"]
  >(provider?.tokenEndpointAuthMethod ?? "client_secret_basic");
  const [claimError, setClaimError] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const clientSecret = String(data.get("clientSecret") ?? "");
    const claim = String(data.get("externalRealmClaim") ?? "").trim();
    if (resolution !== "connection") {
      // "connection" typed here means the administrator meant the resolution
      // mode of that name, not an IdP claim — saving it would make every
      // login fail claim lookup.
      const mode = OIDC_RESOLUTIONS.find((candidate) => candidate.value === claim);
      if (mode) {
        setClaimError(
          `“${claim}” is the name of a resolution mode, not an IdP claim. To resolve Realms that way, choose “${mode.label}” in the Realm resolution dropdown instead.`,
        );
        return;
      }
    }
    setClaimError(null);
    void onSave({
      displayName: String(data.get("displayName") ?? ""),
      issuer: String(data.get("issuer") ?? ""),
      clientId: String(data.get("clientId") ?? ""),
      ...(clientSecret ? { clientSecret } : {}),
      scopes: String(data.get("scopes") ?? "")
        .split(/\s+/)
        .filter(Boolean),
      tokenEndpointAuthMethod: authMethod,
      externalRealmResolution: resolution,
      ...(resolution === "connection" ? {} : { externalRealmClaim: claim }),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>OIDC Provider</CardTitle>
        <CardDescription>
          Delegates identity to your OpenID Connect provider over authorization code with PKCE.
          Register this exact redirect URI at the IdP:
        </CardDescription>
        {oidcRedirectUri ? (
          <code className="w-fit rounded bg-muted px-2 py-1 text-sm">{oidcRedirectUri}</code>
        ) : null}
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={nameId}>Display name</FieldLabel>
                <Input
                  id={nameId}
                  name="displayName"
                  defaultValue={provider?.displayName ?? "OIDC"}
                  required
                  disabled={pending !== null}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={issuerId}>Issuer</FieldLabel>
                <Input
                  id={issuerId}
                  name="issuer"
                  type="url"
                  placeholder="https://account.jinshuju.net"
                  defaultValue={provider?.issuer ?? ""}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending !== null}
                />
                <FieldDescription>
                  Exactly as the IdP publishes it; discovery loads /.well-known/openid-configuration
                  from here.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={clientIdId}>Client ID</FieldLabel>
                <Input
                  id={clientIdId}
                  name="clientId"
                  defaultValue={provider?.clientId ?? ""}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending !== null}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={secretId}>Client secret</FieldLabel>
                <Input
                  id={secretId}
                  name="clientSecret"
                  type="password"
                  placeholder={provider?.clientSecretConfigured ? "•••••• (configured)" : ""}
                  autoComplete="new-password"
                  disabled={pending !== null}
                />
                <FieldDescription>
                  {provider?.clientSecretConfigured
                    ? "Stored encrypted. Leave empty to keep the current secret; entering one rotates it and signs OIDC users out."
                    : "Required unless the client authenticates with none."}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={scopesId}>Scopes</FieldLabel>
                <Input
                  id={scopesId}
                  name="scopes"
                  defaultValue={provider?.scopes.join(" ") || "openid profile email"}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending !== null}
                />
                <FieldDescription>Space-separated; must include openid.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="identity-oidc-auth-method">Token endpoint auth</FieldLabel>
                <Select
                  value={authMethod}
                  onValueChange={(value) => {
                    if (value) {
                      setAuthMethod(
                        value as OidcIdentityProviderConfigInput["tokenEndpointAuthMethod"],
                      );
                    }
                  }}
                >
                  <SelectTrigger id="identity-oidc-auth-method" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="client_secret_basic">client_secret_basic</SelectItem>
                    <SelectItem value="client_secret_post">client_secret_post</SelectItem>
                    <SelectItem value="none">none (public client + PKCE)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="identity-oidc-resolution">Realm resolution</FieldLabel>
                <Select
                  value={resolution}
                  onValueChange={(value) => {
                    if (value) {
                      setResolution(
                        value as OidcIdentityProviderConfigInput["externalRealmResolution"],
                      );
                      setClaimError(null);
                    }
                  }}
                >
                  <SelectTrigger id="identity-oidc-resolution" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OIDC_RESOLUTIONS.map((candidate) => (
                      <SelectItem key={candidate.value} value={candidate.value}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {OIDC_RESOLUTIONS.find((candidate) => candidate.value === resolution)
                    ?.description ?? ""}
                </FieldDescription>
              </Field>
              {resolution !== "connection" ? (
                <Field data-invalid={claimError !== null}>
                  <FieldLabel htmlFor={claimId}>Realm claim</FieldLabel>
                  <Input
                    id={claimId}
                    name="externalRealmClaim"
                    placeholder="account_id"
                    defaultValue={provider?.externalRealmClaim ?? ""}
                    required
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending !== null}
                    aria-invalid={claimError !== null || undefined}
                    onChange={() => setClaimError(null)}
                  />
                  {claimError ? <FieldError>{claimError}</FieldError> : null}
                  <FieldDescription>
                    The claim whose value names the caller's external Realm.
                  </FieldDescription>
                </Field>
              ) : null}
            </div>
            <Field orientation="horizontal">
              <Button type="submit" className="rounded-full" disabled={pending !== null}>
                {pending === "oidc-provider" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <KeyRoundIcon data-icon="inline-start" />
                )}
                {pending === "oidc-provider"
                  ? "Saving…"
                  : provider
                    ? "Save OIDC Provider"
                    : "Configure OIDC Provider"}
              </Button>
              {provider ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void onPreflight()}
                  disabled={pending !== null}
                >
                  {pending === "preflight-oidc" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ShieldCheckIcon data-icon="inline-start" />
                  )}
                  {pending === "preflight-oidc" ? "Running preflight…" : "Run preflight"}
                </Button>
              ) : null}
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function OidcRealmsCard({
  provider,
  realms,
  pending,
  onCreate,
  onToggle,
}: {
  provider: PublicIdentityProvider;
  realms: IdentityRealm[];
  pending: string | null;
  onCreate: (input: {
    externalRealmId: string;
    externalRealmKind: Exclude<ExternalRealmKind, "internal">;
    displayName: string;
  }) => Promise<void>;
  onToggle: (realm: IdentityRealm, enabled: boolean) => Promise<void>;
}) {
  const realmIdId = useId();
  const realmNameId = useId();
  const [kind, setKind] = useState<(typeof OIDC_REALM_KINDS)[number]>("account");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void onCreate({
      externalRealmId: String(data.get("externalRealmId") ?? ""),
      externalRealmKind: kind,
      displayName: String(data.get("displayName") ?? ""),
    }).then(() => form.reset());
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Allowed OIDC Realms</CardTitle>
        <CardDescription>
          Logins only succeed when they resolve to a Realm registered here.
          {provider.externalRealmResolution === "connection"
            ? " Whole-connection resolution uses exactly one enabled Realm."
            : ` The Realm is read from the ${provider.externalRealmClaim ?? "configured"} claim.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {realms.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {realms.map((realm) => (
              <li key={realm.id} className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{realm.displayName}</span>
                  <span className="text-sm text-muted-foreground">
                    <code>{realm.externalRealmId}</code> · {realm.externalRealmKind}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={realm.enabled ? "default" : "secondary"}>
                    {realm.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Switch
                    aria-label={`Enable Realm ${realm.displayName}`}
                    checked={realm.enabled}
                    onCheckedChange={(enabled) => void onToggle(realm, enabled)}
                    disabled={pending !== null}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Alert>
            <FingerprintIcon />
            <AlertDescription>
              No Realm is allowed yet, so every OIDC login is rejected. Register the first one
              below.
            </AlertDescription>
          </Alert>
        )}
        <form onSubmit={submit} className="border-t pt-5">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor={realmIdId}>External Realm ID</FieldLabel>
                <Input
                  id={realmIdId}
                  name="externalRealmId"
                  placeholder="acct_42"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending !== null}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={realmNameId}>Display name</FieldLabel>
                <Input id={realmNameId} name="displayName" required disabled={pending !== null} />
              </Field>
              <Field>
                <FieldLabel htmlFor="identity-oidc-realm-kind">Kind</FieldLabel>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    if (value) setKind(value as (typeof OIDC_REALM_KINDS)[number]);
                  }}
                >
                  <SelectTrigger id="identity-oidc-realm-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OIDC_REALM_KINDS.map((candidate) => (
                      <SelectItem key={candidate} value={candidate}>
                        {candidate}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <Button type="submit" className="rounded-full" disabled={pending !== null}>
                {pending === "oidc-realm" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <FingerprintIcon data-icon="inline-start" />
                )}
                {pending === "oidc-realm" ? "Adding…" : "Allow Realm"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
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
        "flex items-start gap-3 rounded-xl border p-4 text-left transition-colors",
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
