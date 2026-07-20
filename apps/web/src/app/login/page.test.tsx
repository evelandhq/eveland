import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as React from "react";

const auth = vi.hoisted(() => ({
  getCurrentMemberOrNull: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/server-api", () => ({
  getCurrentMemberOrNull: auth.getCurrentMemberOrNull,
}));

vi.mock("@/components/login-form", () => ({
  LoginForm: () => null,
}));

vi.mock("@/components/ui/card", () => ({
  Card: "div",
  CardContent: "div",
  CardDescription: "div",
  CardHeader: "div",
  CardTitle: "div",
}));

vi.mock("next/navigation", () => ({
  redirect: auth.redirect,
}));

import LoginPage from "./page";

describe("login page", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    auth.getCurrentMemberOrNull.mockReset();
    auth.redirect.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  test("redirects an authenticated member to the projects home", async () => {
    auth.getCurrentMemberOrNull.mockResolvedValue({
      email: "admin@example.com",
      image: null,
      name: "Admin",
      role: "admin",
    });

    await LoginPage();

    expect(auth.getCurrentMemberOrNull).toHaveBeenCalledOnce();
    expect(auth.redirect).toHaveBeenCalledWith("/projects");
  });

  test("renders the sign-in page without an authenticated member", async () => {
    auth.getCurrentMemberOrNull.mockResolvedValue(null);

    await expect(LoginPage()).resolves.toBeTruthy();

    expect(auth.redirect).not.toHaveBeenCalled();
  });
});
