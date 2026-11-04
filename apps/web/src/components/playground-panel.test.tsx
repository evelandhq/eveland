// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionNotActiveError, SessionStore } from "eve/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EveVersionInfo } from "@/lib/api";

const agent = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

// The conversation pane sticks to the bottom through ResizeObserver, which
// jsdom does not implement.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

vi.mock("eve/react", () => ({
  useEveAgent: () => agent.current,
}));

import { PlaygroundPanel } from "./playground-panel";

const eveVersion: EveVersionInfo = {
  version: "1.0.0-rc.1",
  supported: true,
  expected: "1.0.x",
  supportedRanges: ["1.0.x"],
  sourceRevisionId: null,
};

// An in-flight first submission: the create request has not answered, so the
// client holds no session handle yet.
function firstSubmissionInFlight(cancel: () => Promise<unknown>) {
  agent.current = {
    status: "busy",
    session: undefined,
    messages: [],
    view: new SessionStore({}).snapshot.view,
    error: undefined,
    send: vi.fn(() => new Promise(() => {})),
    cancel,
    respond: vi.fn(),
  };
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe("PlaygroundPanel Stop", () => {
  test("requests durable cancellation through the Eve client before the first create answers", async () => {
    const cancel = vi.fn(() => Promise.resolve({ deliveryId: "d" }));
    firstSubmissionInFlight(cancel);
    render(<PlaygroundPanel projectId="proj_1" eveVersion={eveVersion} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    // eve's SessionStore.cancel waits for the pending submission's turn and
    // then sends the canonical cancellation; aborting the HTTP request would
    // leave an accepted turn running.
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  test("a first create that never produced a session leaves nothing to cancel and no error", async () => {
    const cancel = vi.fn(() => Promise.reject(new SessionNotActiveError()));
    firstSubmissionInFlight(cancel);
    render(<PlaygroundPanel projectId="proj_1" eveVersion={eveVersion} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.queryByText(/not active/i)).toBeNull();
  });
});
