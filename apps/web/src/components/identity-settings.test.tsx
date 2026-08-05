// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  createInternalIdentityProvider: vi.fn(),
  createInternalIdentityRealm: vi.fn(),
  createOpenIdentityProvider: vi.fn(),
  preflightIdentityProvider: vi.fn(),
  setIdentityProviderEnabled: vi.fn(),
  updateIdentityRealm: vi.fn(),
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

function renderSettings(providers: PublicIdentityProvider[]) {
  render(
    <IdentitySettings initialProviders={providers} initialRealms={[]} initialReturnTargets={[]} />,
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
