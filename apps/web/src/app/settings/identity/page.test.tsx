import { beforeEach, describe, expect, test, vi } from "vitest";
import * as React from "react";

const server = vi.hoisted(() => ({
  getCurrentMember: vi.fn(),
  getIdentityProviders: vi.fn(),
  getIdentityRealms: vi.fn(),
  getIdentityReturnTargets: vi.fn(),
}));

vi.mock("@/lib/server-api", () => server);
vi.mock("@/components/identity-settings", () => ({
  IdentitySettings: (props: unknown) =>
    React.createElement("identity-settings", { value: props }),
}));
vi.mock("@/components/ui/card", () => ({
  Card: "div",
  CardContent: "div",
  CardDescription: "div",
  CardHeader: "div",
  CardTitle: "div",
}));

import IdentitySettingsPage from "./page";

describe("Identity settings page", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    Object.values(server).forEach((mock) => mock.mockReset());
  });

  test("loads provider, Realm, and return target context for an admin", async () => {
    server.getCurrentMember.mockResolvedValue({ role: "admin" });
    server.getIdentityProviders.mockResolvedValue([
      { id: "idpc_1", type: "internal", displayName: "Eveland Internal" },
    ]);
    server.getIdentityRealms.mockResolvedValue([
      { id: "irlm_1", providerConnectionId: "idpc_1" },
    ]);
    server.getIdentityReturnTargets.mockResolvedValue([
      { id: "irtg_1", key: "eve-chats", origin: "http://localhost:3010", enabled: true },
    ]);

    await expect(IdentitySettingsPage()).resolves.toBeTruthy();
    expect(server.getIdentityProviders).toHaveBeenCalledOnce();
    expect(server.getIdentityRealms).toHaveBeenCalledOnce();
    expect(server.getIdentityReturnTargets).toHaveBeenCalledOnce();
  });

  test("does not load identity configuration for a non-admin member", async () => {
    server.getCurrentMember.mockResolvedValue({ role: "member" });

    await expect(IdentitySettingsPage()).resolves.toBeTruthy();
    expect(server.getIdentityProviders).not.toHaveBeenCalled();
    expect(server.getIdentityRealms).not.toHaveBeenCalled();
    expect(server.getIdentityReturnTargets).not.toHaveBeenCalled();
  });
});
