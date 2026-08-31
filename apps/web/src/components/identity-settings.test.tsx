// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  createInternalIdentityProvider: vi.fn(),
  createInternalIdentityRealm: vi.fn(),
  createOidcIdentityProvider: vi.fn(),
  createOidcIdentityRealm: vi.fn(),
  createOpenIdentityProvider: vi.fn(),
  preflightIdentityProvider: vi.fn(),
  setIdentityProviderEnabled: vi.fn(),
  updateIdentityRealm: vi.fn(),
  updateOidcIdentityProvider: vi.fn(),
  upsertIdentityReturnTarget: vi.fn(),
}));

vi.mock("@/lib/client-api", () => api);

import { IdentitySettings } from "./identity-settings";
import type { PublicIdentityProvider } from "@/lib/api";

const openProvider = provider({ id: "idpc_open", type: "open", displayName: "Open for all" });
const internalProvider = provider({
  id: "idpc_internal",
  type: "internal",
  displayName: "Eveland Internal",
  internalRealmKey: "members",
  enabled: false,
});
const oidcProvider = provider({
  id: "idpc_oidc",
  type: "oidc",
  displayName: "金数据",
  issuer: "https://account.jinshuju.net",
  clientId: "eveland-client",
  clientSecretConfigured: true,
  scopes: ["openid", "profile", "email"],
  tokenEndpointAuthMethod: "client_secret_basic",
  externalRealmResolution: "id_token_claim",
  externalRealmClaim: "account_id",
  enabled: false,
});

describe("IdentitySettings provider selection", () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
  });

  test("disables the outgoing Provider before enabling the incoming one", async () => {
    const calls: Array<{ id: string; enabled: boolean }> = [];
    api.setIdentityProviderEnabled.mockImplementation(
      async (input: { id: string; enabled: boolean }) => {
        calls.push({ id: input.id, enabled: input.enabled });
        return { ...(input.id === "idpc_open" ? openProvider : internalProvider), ...input };
      },
    );

    renderSettings([openProvider, internalProvider]);
    fireEvent.click(screen.getByRole("radio", { name: /Eveland Internal/ }));
    fireEvent.click(screen.getByRole("button", { name: /Switch Identity Provider/ }));

    // Only one Provider may be enabled at a time, so the order is load-bearing:
    // enabling first would collide with the Provider still switched on.
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { id: "idpc_open", enabled: false },
      { id: "idpc_internal", enabled: true },
    ]);
  });

  test("warns that the switch invalidates existing identity sessions", async () => {
    renderSettings([openProvider, internalProvider]);

    fireEvent.click(screen.getByRole("radio", { name: /Eveland Internal/ }));

    expect(screen.getByText(/stops authenticating anyone/i)).toBeDefined();
    expect(api.setIdentityProviderEnabled).not.toHaveBeenCalled();
  });

  test("restores the previous Provider when enabling the replacement fails", async () => {
    api.setIdentityProviderEnabled.mockImplementation(
      async (input: { id: string; enabled: boolean }) => {
        if (input.id === "idpc_internal" && input.enabled) {
          throw new Error("Identity Provider was updated by another request.");
        }
        return { ...(input.id === "idpc_open" ? openProvider : internalProvider), ...input };
      },
    );

    renderSettings([openProvider, internalProvider]);
    fireEvent.click(screen.getByRole("radio", { name: /Eveland Internal/ }));
    fireEvent.click(screen.getByRole("button", { name: /Switch Identity Provider/ }));

    // A half-applied switch would leave the instance with no Provider enabled
    // at all, which is not one of the three states an administrator can pick.
    await waitFor(() => expect(screen.getByText(/updated by another request/i)).toBeDefined());
    expect(api.setIdentityProviderEnabled).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "idpc_open", enabled: true }),
    );
  });

  test("creates the open Provider on demand when the instance has never had one", async () => {
    const enabledInternal = { ...internalProvider, enabled: true };
    api.createOpenIdentityProvider.mockResolvedValue(openProvider);
    api.setIdentityProviderEnabled.mockImplementation(
      async (input: { id: string; enabled: boolean }) => ({ ...openProvider, ...input }),
    );

    renderSettings([enabledInternal]);
    fireEvent.click(screen.getByRole("radio", { name: /Open for all/ }));
    fireEvent.click(screen.getByRole("button", { name: /Switch Identity Provider/ }));

    // Instances that already ran Eveland Internal skipped the migration seed,
    // so the open Provider row simply does not exist for them yet.
    await waitFor(() => expect(api.createOpenIdentityProvider).toHaveBeenCalledOnce());
    expect(api.createOpenIdentityProvider).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });
});

describe("IdentitySettings OIDC configuration", () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
  });

  test("keeps OIDC unselectable until a connection is configured", () => {
    renderSettings([openProvider]);

    const option = screen.getByRole("radio", { name: /OIDC/ });
    expect(option.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText(/Configure it below first/).length).toBeGreaterThan(0);
  });

  test("creates the OIDC connection disabled, with the parsed form configuration", async () => {
    api.createOidcIdentityProvider.mockResolvedValue(oidcProvider);
    renderSettings([openProvider]);

    fireEvent.change(screen.getByLabelText("Issuer"), {
      target: { value: "https://account.jinshuju.net" },
    });
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "eveland-client" },
    });
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "s3cret-value" },
    });
    fireEvent.change(screen.getByLabelText("Scopes"), {
      target: { value: "openid  profile email" },
    });
    fireEvent.change(screen.getByLabelText("Realm claim"), {
      target: { value: "account_id" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Configure OIDC Provider/ }));

    await waitFor(() => expect(api.createOidcIdentityProvider).toHaveBeenCalledOnce());
    // Created disabled, like the other Providers: a failure here must leave
    // the platform on whatever Provider it was already using.
    expect(api.createOidcIdentityProvider).toHaveBeenCalledWith({
      displayName: "OIDC",
      issuer: "https://account.jinshuju.net",
      clientId: "eveland-client",
      clientSecret: "s3cret-value",
      scopes: ["openid", "profile", "email"],
      tokenEndpointAuthMethod: "client_secret_basic",
      externalRealmResolution: "id_token_claim",
      externalRealmClaim: "account_id",
      enabled: false,
    });
  });

  test("changing Realm resolution to whole-connection reaches the update call", async () => {
    api.updateOidcIdentityProvider.mockResolvedValue({
      ...oidcProvider,
      externalRealmResolution: "connection",
      externalRealmClaim: null,
    });
    renderSettings([openProvider, oidcProvider]);

    pickOption(screen.getByRole("combobox", { name: "Realm resolution" }), "Whole connection");
    fireEvent.click(screen.getByRole("button", { name: /Save OIDC Provider/ }));

    // A first-time setup ended with the dropdown's stored value silently
    // unchanged (issue: every login then failed identity_oidc_claims_invalid),
    // so the controlled Select state must provably flow into the PATCH.
    await waitFor(() => expect(api.updateOidcIdentityProvider).toHaveBeenCalledOnce());
    const input = api.updateOidcIdentityProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ externalRealmResolution: "connection" });
    expect(input).not.toHaveProperty("externalRealmClaim");
    // The notice echoes the stored resolution so a save that did not apply
    // what the administrator expected is visible immediately.
    expect(screen.getByText(/Realm resolution “Whole connection”/)).toBeDefined();
  });

  test("rejects a resolution-mode name typed into the Realm claim field", async () => {
    renderSettings([openProvider, oidcProvider]);

    fireEvent.change(screen.getByLabelText("Realm claim"), {
      target: { value: "connection" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save OIDC Provider/ }));

    // The incident input: the user typed the resolution mode's name into the
    // claim field; the IdP never issues a claim by that name, so the save
    // must stop client-side and point at the dropdown.
    expect(
      await screen.findByText(/choose “Whole connection” in the Realm resolution/),
    ).toBeDefined();
    expect(api.updateOidcIdentityProvider).not.toHaveBeenCalled();

    // Correcting the claim clears the error and lets the save through.
    api.updateOidcIdentityProvider.mockResolvedValue(oidcProvider);
    fireEvent.change(screen.getByLabelText("Realm claim"), {
      target: { value: "account_id" },
    });
    expect(screen.queryByText(/resolution mode, not an IdP claim/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save OIDC Provider/ }));
    await waitFor(() => expect(api.updateOidcIdentityProvider).toHaveBeenCalledOnce());
  });

  test("keeps the stored client secret when the field is left empty on update", async () => {
    api.updateOidcIdentityProvider.mockResolvedValue(oidcProvider);
    renderSettings([openProvider, oidcProvider]);

    fireEvent.click(screen.getByRole("button", { name: /Save OIDC Provider/ }));

    await waitFor(() => expect(api.updateOidcIdentityProvider).toHaveBeenCalledOnce());
    const input = api.updateOidcIdentityProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).not.toHaveProperty("clientSecret");
    expect(input).toMatchObject({
      id: "idpc_oidc",
      expectedSecurityRevision: oidcProvider.securityRevision,
    });
  });

  test("registers an allowed Realm for the OIDC connection", async () => {
    api.createOidcIdentityRealm.mockResolvedValue({
      id: "irlm_oidc",
      providerConnectionId: "idpc_oidc",
      externalRealmId: "acct_42",
      externalRealmKind: "account",
      displayName: "金数据团队",
      enabled: true,
    });
    renderSettings([oidcProvider]);

    // Several cards carry a "Display name" field; scope to the realm form.
    const realmForm = within(screen.getByRole("button", { name: /Allow Realm/ }).closest("form")!);
    fireEvent.change(realmForm.getByLabelText("External Realm ID"), {
      target: { value: "acct_42" },
    });
    fireEvent.change(realmForm.getByLabelText("Display name"), {
      target: { value: "金数据团队" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Allow Realm/ }));

    await waitFor(() => expect(api.createOidcIdentityRealm).toHaveBeenCalledOnce());
    expect(api.createOidcIdentityRealm).toHaveBeenCalledWith({
      providerConnectionId: "idpc_oidc",
      externalRealmId: "acct_42",
      externalRealmKind: "account",
      displayName: "金数据团队",
      enabled: true,
    });
  });

  test("surfaces failing preflight checks by name", async () => {
    api.preflightIdentityProvider.mockResolvedValue({
      ok: false,
      checks: { discovery: true, tokenEndpointAuthMethod: false },
    });
    renderSettings([oidcProvider]);

    fireEvent.click(screen.getByRole("button", { name: /Run preflight/ }));

    await waitFor(() =>
      expect(screen.getByText(/OIDC preflight failed: tokenEndpointAuthMethod/)).toBeDefined(),
    );
  });

  test("warns that switching to OIDC turns off the Playground identity credential", () => {
    renderSettings([openProvider, oidcProvider]);

    fireEvent.click(screen.getByRole("radio", { name: /OIDC/ }));

    expect(screen.getByText(/Playground's Eveland Identity credential/)).toBeDefined();
    expect(api.setIdentityProviderEnabled).not.toHaveBeenCalled();
  });
});

/**
 * Drives a Base UI Select in jsdom: click opens the popup, but committing an
 * option needs the full pointer-then-click sequence — a bare click on the
 * option is swallowed by Base UI's click-through guard and selects nothing.
 */
function pickOption(trigger: HTMLElement, name: string) {
  fireEvent.click(trigger);
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.mouseDown(option);
  fireEvent.pointerUp(option);
  fireEvent.mouseUp(option);
  fireEvent.click(option);
}

function renderSettings(providers: PublicIdentityProvider[]) {
  render(
    <IdentitySettings
      initialProviders={providers}
      initialRealms={[]}
      initialReturnTargets={[]}
      oidcRedirectUri="http://localhost:4000/api/identity/oidc/callback"
    />,
  );
}

function provider(overrides: Partial<PublicIdentityProvider>): PublicIdentityProvider {
  return {
    id: "idpc_1",
    type: "open",
    displayName: "Open for all",
    internalRealmKey: null,
    issuer: null,
    clientId: null,
    clientSecretConfigured: false,
    scopes: [],
    authorizationParameters: {},
    tokenEndpointAuthMethod: null,
    externalRealmResolution: "open_shared",
    externalRealmClaim: null,
    enabled: true,
    securityRevision: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}
