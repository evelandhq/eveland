// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  previewPasswordReset: vi.fn(),
  completePasswordReset: vi.fn(),
}));
vi.mock("@/lib/client-api", () => api);

import { ResetPasswordForm } from "./reset-password-form";

describe("ResetPasswordForm", () => {
  beforeEach(() => {
    api.previewPasswordReset.mockReset();
    api.completePasswordReset.mockReset();
  });

  test("a valid link reveals the account and sets a new password with policy semantics", async () => {
    api.previewPasswordReset.mockResolvedValue({ email: "member@example.com" });
    api.completePasswordReset.mockResolvedValue(undefined);
    render(<ResetPasswordForm token="pwreset_valid" />);

    expect(api.previewPasswordReset).toHaveBeenCalledExactlyOnceWith("pwreset_valid");
    const password = (await screen.findByLabelText("New password")) as HTMLInputElement;
    expect(password.autocomplete).toBe("new-password");
    expect(password.minLength).toBe(12);
    expect(screen.getByText(/member@example\.com/)).toBeDefined();

    fireEvent.change(password, { target: { value: "a-replacement-password" } });
    fireEvent.submit(password.closest("form")!);

    expect(api.completePasswordReset).toHaveBeenCalledExactlyOnceWith({
      token: "pwreset_valid",
      password: "a-replacement-password",
    });
    // Every session was revoked server-side, so success routes through login.
    await screen.findByText("Password updated");
    expect(screen.getByRole("link", { name: /go to sign in/i }).getAttribute("href")).toBe(
      "/login",
    );
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  test("an invalid link shows the API's answer instead of a dead-end form", async () => {
    api.previewPasswordReset.mockRejectedValue(new Error("Reset link is invalid or has expired"));
    render(<ResetPasswordForm token="pwreset_stale" />);

    await screen.findByText("Reset link is invalid or has expired");
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(api.completePasswordReset).not.toHaveBeenCalled();
  });

  test("a rejected completion surfaces the error and keeps the form usable", async () => {
    api.previewPasswordReset.mockResolvedValue({ email: "member@example.com" });
    api.completePasswordReset.mockRejectedValue(new Error("Reset link is invalid or has expired"));
    render(<ResetPasswordForm token="pwreset_consumed" />);

    const password = (await screen.findByLabelText("New password")) as HTMLInputElement;
    fireEvent.change(password, { target: { value: "a-replacement-password" } });
    fireEvent.submit(password.closest("form")!);

    await screen.findByText("Reset link is invalid or has expired");
    expect(screen.queryByText("Password updated")).toBeNull();
    expect(screen.getByLabelText("New password")).toBeDefined();
  });
});
