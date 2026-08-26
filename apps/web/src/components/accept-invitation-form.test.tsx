// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  previewInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/client-api", () => api);
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { AcceptInvitationForm } from "./accept-invitation-form";

describe("AcceptInvitationForm", () => {
  beforeEach(() => {
    api.previewInvitation.mockReset();
    api.acceptInvitation.mockReset();
    router.push.mockClear();
    router.refresh.mockClear();
  });

  test("a new email gets profile creation with new-password semantics", async () => {
    api.previewInvitation.mockResolvedValue({
      email: "newcomer@example.com",
      existingAccount: false,
    });
    api.acceptInvitation.mockResolvedValue({});
    render(<AcceptInvitationForm token="invitation_new" />);

    expect(api.previewInvitation).toHaveBeenCalledExactlyOnceWith("invitation_new");
    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(password.autocomplete).toBe("new-password");
    expect(password.minLength).toBe(12);
    expect(screen.getByText("Use at least 12 characters.")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Newcomer" } });
    fireEvent.change(password, { target: { value: "newcomer-password" } });
    fireEvent.submit(password.closest("form")!);

    expect(api.acceptInvitation).toHaveBeenCalledExactlyOnceWith({
      token: "invitation_new",
      name: "Newcomer",
      password: "newcomer-password",
    });
    await screen.findByRole("button", { name: /join team/i });
    expect(router.push).toHaveBeenCalledWith("/projects");
  });

  test("an existing account gets an explicit rejoin flow with its current password", async () => {
    api.previewInvitation.mockResolvedValue({
      email: "rejoiner@example.com",
      existingAccount: true,
    });
    api.acceptInvitation.mockResolvedValue({});
    render(<AcceptInvitationForm token="invitation_rejoin" />);

    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(password.autocomplete).toBe("current-password");
    expect(password.minLength).not.toBe(12);
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByText("Use at least 12 characters.")).toBeNull();
    expect(screen.getByText(/rejoiner@example\.com/)).toBeDefined();
    expect(screen.getByText(/already has an account/i)).toBeDefined();

    fireEvent.change(password, { target: { value: "original-password" } });
    fireEvent.submit(password.closest("form")!);

    expect(api.acceptInvitation).toHaveBeenCalledExactlyOnceWith({
      token: "invitation_rejoin",
      password: "original-password",
    });
    await screen.findByRole("button", { name: /rejoin team/i });
    expect(router.push).toHaveBeenCalledWith("/projects");
  });

  test("an invalid invitation shows the API's answer instead of a dead-end form", async () => {
    api.previewInvitation.mockRejectedValue(new Error("Invitation is no longer pending"));
    render(<AcceptInvitationForm token="invitation_stale" />);

    await screen.findByText("Invitation is no longer pending");
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
});
