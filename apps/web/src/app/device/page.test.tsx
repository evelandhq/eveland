import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as React from "react";

const auth = vi.hoisted(() => ({
  getCurrentMemberOrNull: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/server-api", () => ({
  getCurrentMemberOrNull: auth.getCurrentMemberOrNull,
}));

vi.mock("@/components/device-authorization-form", () => ({
  DeviceAuthorizationForm: "div",
}));

vi.mock("@/components/ui/card", () => ({
  Card: "div",
  CardContent: "div",
  CardDescription: "div",
  CardHeader: "div",
  CardTitle: "div",
}));

vi.mock("next/navigation", () => ({ redirect: auth.redirect }));

import DevicePage from "./page";

describe("device authorization page", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    auth.getCurrentMemberOrNull.mockReset();
    auth.redirect.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  test("returns an unauthenticated browser to this device request after sign-in", async () => {
    auth.getCurrentMemberOrNull.mockResolvedValue(null);

    await DevicePage({
      searchParams: Promise.resolve({ user_code: "ABCD-1234" }),
    });

    expect(auth.redirect).toHaveBeenCalledWith(
      "/login?next=%2Fdevice%3Fuser_code%3DABCD-1234",
    );
  });

  test("renders the approval page for a signed-in team member", async () => {
    auth.getCurrentMemberOrNull.mockResolvedValue({
      email: "admin@example.com",
      image: null,
      name: "Admin",
      role: "admin",
    });

    await expect(
      DevicePage({
        searchParams: Promise.resolve({ user_code: "ABCD-1234" }),
      }),
    ).resolves.toBeTruthy();
    expect(auth.redirect).not.toHaveBeenCalled();
  });
});
