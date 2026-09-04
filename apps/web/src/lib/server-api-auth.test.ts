import { afterEach, describe, expect, test, vi } from "vitest";
import { getApiBuildInfo, getCurrentMemberOrNull } from "./server-api";

const cookieStore = { toString: () => "eveland_session=session-token" };

vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

describe("server auth API", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("returns the current member for a valid session", async () => {
    const member = { email: "admin@example.com", image: null, name: "Admin", role: "admin" };
    const fetchMock = vi.fn(async () => Response.json({ member }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCurrentMemberOrNull()).resolves.toEqual(member);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:17301/api/members/me", {
      cache: "no-store",
      headers: { cookie: "eveland_session=session-token" },
    });
  });

  // `/health` is the API's own top-level namespace, not part of the browser
  // plane behind `/api`; dialling `/api/health` 404s and the About page then
  // reports the API build as unavailable.
  test("reads the API build identity from the private origin's root", async () => {
    const build = { component: "api", version: "0.51.1", revision: "abc123", channel: "edge" };
    const fetchMock = vi.fn(async () => Response.json({ ok: true, ...build }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getApiBuildInfo()).resolves.toEqual({ ok: true, ...build });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:17301/health", {
      cache: "no-store",
    });
  });

  test("returns null for an invalid or missing session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    await expect(getCurrentMemberOrNull()).resolves.toBeNull();
  });
});
