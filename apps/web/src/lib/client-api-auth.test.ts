import { afterEach, describe, expect, test, vi } from "vitest";

import { acceptInvitation, signIn } from "./client-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// Authentication endpoints answer 401 for a rejected credential. The shared
// transport's session-expiry policy must not apply there: the user needs the
// endpoint's message, and there is nowhere to redirect them to -- they are
// already on the page that signs them in.
describe("credential rejection reaches the user", () => {
  test("a wrong password surfaces the API's message, not a session-expiry line", async () => {
    mockFetch(Response.json({ error: "Invalid email or password" }, { status: 401 }));
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/login", search: "", assign },
    });

    await expect(signIn("admin@example.com", "wrong")).rejects.toThrow("Invalid email or password");
    expect(assign).not.toHaveBeenCalled();
  });

  test("an invitation accepted with a rejected credential surfaces its own message", async () => {
    mockFetch(Response.json({ error: "Invalid email or password" }, { status: 401 }));
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/accept-invite", search: "?token=invh_1", assign },
    });

    await expect(
      acceptInvitation({ token: "tok", name: "Member", password: "short" }),
    ).rejects.toThrow("Invalid email or password");
    expect(assign).not.toHaveBeenCalled();
  });
});
