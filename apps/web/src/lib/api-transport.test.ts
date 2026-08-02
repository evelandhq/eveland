import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ApiUnauthorizedError,
  apiFetch,
  apiRequest,
  decodeApiError,
} from "./api-transport.js";

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

describe("browser API transport", () => {
  test("sends the session cookie on every browser call", async () => {
    const fetchMock = mockFetch(Response.json({ ok: true }));

    await apiRequest("/projects", { method: "POST" });
    await apiFetch("/source-preflights", { method: "POST" });

    // Control-plane routes are cookie-authenticated: a call that omits
    // credentials is an anonymous 401, not a working request.
    for (const [, init] of fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >) {
      expect(init.credentials).toBe("include");
    }
  });

  test("surfaces a field-level validation issue over the generic error line", async () => {
    mockFetch(
      Response.json(
        {
          error: "Invalid request",
          issues: [{ message: "Environment variable keys must be unique." }],
        },
        { status: 400 },
      ),
    );

    await expect(apiRequest("/projects", { method: "POST" })).rejects.toThrow(
      "Environment variable keys must be unique.",
    );
  });

  test("falls back through the error contract and finally to the status", async () => {
    await expect(
      decodeApiError(Response.json({ detail: "detailed" }, { status: 400 })),
    ).resolves.toBe("detailed");
    await expect(
      decodeApiError(Response.json({ error: "plain" }, { status: 400 })),
    ).resolves.toBe("plain");
    await expect(
      decodeApiError(new Response("not json", { status: 503 })),
    ).resolves.toBe("Request failed with 503");
  });

  test("treats an expired session as a redirect to login, not a raw error", async () => {
    mockFetch(Response.json({ error: "Authentication required" }, { status: 401 }));
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/projects/proj_1", search: "?tab=logs", assign },
    });

    await expect(apiRequest("/projects/proj_1")).rejects.toBeInstanceOf(
      ApiUnauthorizedError,
    );
    expect(assign).toHaveBeenCalledWith(
      "/login?next=%2Fprojects%2Fproj_1%3Ftab%3Dlogs",
    );
  });

  test("does not loop when the login page itself is unauthorized", async () => {
    mockFetch(Response.json({ error: "Authentication required" }, { status: 401 }));
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/login", search: "", assign },
    });

    await expect(apiRequest("/auth/session")).rejects.toBeInstanceOf(
      ApiUnauthorizedError,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  test("reports an absent optional resource as null and a 204 as no content", async () => {
    mockFetch(new Response(null, { status: 404 }));
    await expect(
      apiRequest("/projects/proj_missing", { optional: true }),
    ).resolves.toBeNull();

    mockFetch(new Response(null, { status: 204 }));
    await expect(
      apiRequest("/invitations/invh_1", { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });
});
