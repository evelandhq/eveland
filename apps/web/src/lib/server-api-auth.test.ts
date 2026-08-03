import { afterEach, describe, expect, test, vi } from "vitest";
import { getCurrentMemberOrNull } from "./server-api";

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
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/auth/session", {
      cache: "no-store",
      headers: { cookie: "eveland_session=session-token" },
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
