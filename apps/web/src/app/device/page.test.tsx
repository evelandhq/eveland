// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getCurrentMember: vi.fn(),
}));

vi.mock("@/lib/server-api", () => ({
  getCurrentMember: auth.getCurrentMember,
}));

vi.mock("@/components/device-approval-form", () => ({
  DeviceApprovalForm: ({ initialUserCode }: { initialUserCode?: string }) => (
    <div data-testid="device-approval-form">{initialUserCode ?? "no-code"}</div>
  ),
}));

import DevicePage from "./page";

describe("device page", () => {
  beforeEach(() => {
    auth.getCurrentMember.mockReset();
    auth.getCurrentMember.mockResolvedValue({
      email: "admin@example.com",
      image: null,
      name: "Admin",
      role: "admin",
    });
  });

  test("requires a session and forwards the URL's user_code to the form", async () => {
    render(await DevicePage({ searchParams: Promise.resolve({ user_code: "WDJB-MJHT" }) }));

    expect(auth.getCurrentMember).toHaveBeenCalledOnce();
    expect(screen.getByTestId("device-approval-form").textContent).toBe("WDJB-MJHT");
    expect(screen.getByText("Device authorization")).toBeDefined();
  });

  test("falls back to manual code entry when the URL carries no user_code", async () => {
    render(await DevicePage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByTestId("device-approval-form").textContent).toBe("no-code");
  });

  test("propagates the login redirect instead of rendering for a signed-out visitor", async () => {
    // server-api's getCurrentMember throws Next's redirect on 401.
    auth.getCurrentMember.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(DevicePage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
  });
});
