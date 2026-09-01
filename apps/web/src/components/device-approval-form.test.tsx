// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  previewDeviceAuthorization: vi.fn(),
  approveDeviceAuthorization: vi.fn(),
  denyDeviceAuthorization: vi.fn(),
}));
vi.mock("@/lib/client-api", () => api);

import { DeviceApprovalForm } from "./device-approval-form";

const pendingPreview = {
  user_code: "WDJB-MJHT",
  status: "pending",
  client_id: "eveland-cli",
  scope: "deploy observe",
};

describe("DeviceApprovalForm", () => {
  beforeEach(() => {
    api.previewDeviceAuthorization.mockReset();
    api.approveDeviceAuthorization.mockReset();
    api.denyDeviceAuthorization.mockReset();
  });

  test("a pending code renders the client, its scopes, and the code for cross-checking", async () => {
    api.previewDeviceAuthorization.mockResolvedValue(pendingPreview);
    render(<DeviceApprovalForm initialUserCode="WDJB-MJHT" />);

    expect(api.previewDeviceAuthorization).toHaveBeenCalledExactlyOnceWith("WDJB-MJHT");
    await screen.findByText("eveland CLI");
    expect(
      screen.getByText("Deploy agents: create projects, upload source, build and promote"),
    ).toBeDefined();
    expect(screen.getByText("Read projects, deployments, logs and schedules")).toBeDefined();
    expect(screen.getByText("WDJB-MJHT")).toBeDefined();
    expect(screen.getByRole("button", { name: /authorize/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /deny/i })).toBeDefined();
    // RFC 8628: showing the preview must never approve on its own.
    expect(api.approveDeviceAuthorization).not.toHaveBeenCalled();
  });

  test("an unrecognized client and scope are shown verbatim rather than hidden", async () => {
    api.previewDeviceAuthorization.mockResolvedValue({
      user_code: "WDJB-MJHT",
      status: "pending",
      client_id: "some-other-tool",
      scope: "deploy custom:thing",
    });
    render(<DeviceApprovalForm initialUserCode="WDJB-MJHT" />);

    await screen.findByText("some-other-tool");
    expect(screen.getByText("custom:thing")).toBeDefined();
  });

  test("authorizing calls the approve endpoint and ends on the return-to-terminal state", async () => {
    api.previewDeviceAuthorization.mockResolvedValue(pendingPreview);
    api.approveDeviceAuthorization.mockResolvedValue(undefined);
    render(<DeviceApprovalForm initialUserCode="WDJB-MJHT" />);

    fireEvent.click(await screen.findByRole("button", { name: /authorize/i }));

    expect(api.approveDeviceAuthorization).toHaveBeenCalledExactlyOnceWith("WDJB-MJHT");
    await screen.findByText("Device authorized");
    expect(screen.queryByRole("button", { name: /authorize/i })).toBeNull();
    expect(api.denyDeviceAuthorization).not.toHaveBeenCalled();
  });

  test("denying calls the deny endpoint and ends on the denied state", async () => {
    api.previewDeviceAuthorization.mockResolvedValue(pendingPreview);
    api.denyDeviceAuthorization.mockResolvedValue(undefined);
    render(<DeviceApprovalForm initialUserCode="WDJB-MJHT" />);

    fireEvent.click(await screen.findByRole("button", { name: /deny/i }));

    expect(api.denyDeviceAuthorization).toHaveBeenCalledExactlyOnceWith("WDJB-MJHT");
    await screen.findByText("Request denied");
    expect(screen.queryByRole("button", { name: /authorize/i })).toBeNull();
    expect(api.approveDeviceAuthorization).not.toHaveBeenCalled();
  });

  test("an unknown code shows a human message with a way back to code entry", async () => {
    api.previewDeviceAuthorization.mockRejectedValue(new Error("invalid_request"));
    render(<DeviceApprovalForm initialUserCode="WDJB-MJHT" />);

    await screen.findByText(/this code is not recognized/i);
    expect(screen.queryByRole("button", { name: /authorize/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /enter a different code/i }));
    expect(screen.getByLabelText("Code")).toBeDefined();
  });

  test("a code that was already handled cannot be decided again", async () => {
    api.previewDeviceAuthorization.mockResolvedValue({ ...pendingPreview, status: "approved" });
    render(<DeviceApprovalForm initialUserCode="WDJB-MJHT" />);

    await screen.findByText(/already been handled/i);
    expect(screen.queryByRole("button", { name: /authorize/i })).toBeNull();
  });

  test("a rejected approval surfaces the mapped error and keeps the decision open", async () => {
    api.previewDeviceAuthorization.mockResolvedValue(pendingPreview);
    api.approveDeviceAuthorization.mockRejectedValue(new Error("expired_token"));
    render(<DeviceApprovalForm initialUserCode="WDJB-MJHT" />);

    fireEvent.click(await screen.findByRole("button", { name: /authorize/i }));

    await screen.findByText(/this code has expired/i);
    expect(screen.queryByText("Device authorized")).toBeNull();
    expect(screen.getByRole("button", { name: /authorize/i })).toBeDefined();
  });

  test("typed codes are whitespace-stripped and uppercased but keep their hyphens", async () => {
    api.previewDeviceAuthorization.mockResolvedValue(pendingPreview);
    render(<DeviceApprovalForm />);

    const input = screen.getByLabelText("Code");
    fireEvent.change(input, { target: { value: "  wdjb-mjht\n" } });
    fireEvent.submit(input.closest("form")!);

    expect(api.previewDeviceAuthorization).toHaveBeenCalledExactlyOnceWith("WDJB-MJHT");
    await screen.findByText("eveland CLI");
  });
});
