import { afterEach, describe, expect, test, vi } from "vitest";
import { acceptInvitation, inviteMember, signIn, signOut } from "./client-api";

describe("browser auth API", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("signs in with credentialed browser requests", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url).endsWith("/auth/session")
        ? { member: { email: "admin@example.com", role: "admin" } }
        : { user: { email: "admin@example.com" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(signIn("admin@example.com", "admin-password")).resolves.toMatchObject({ role: "admin" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:4000/api/auth/sign-in/email", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost:4000/auth/session", {
      method: "GET",
      credentials: "include",
    });
  });

  test("signs out through Better Auth with a JSON request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(signOut()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });

  test("returns a copyable invitation URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ invitation: { id: "invite_1" }, inviteUrl: "http://localhost:3000/accept-invite?token=token" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(inviteMember("member@example.com")).resolves.toMatchObject({
      inviteUrl: "http://localhost:3000/accept-invite?token=token",
    });
  });

  test("accepts an invitation with the chosen member password", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ member: { email: "member@example.com", role: "member" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await acceptInvitation({ token: "invite-token", name: "Member", password: "member-password" });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/invitations/accept", expect.objectContaining({
      method: "POST",
      credentials: "include",
    }));
  });
});
