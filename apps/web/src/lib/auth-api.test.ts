import { afterEach, describe, expect, test, vi } from "vitest";
import { acceptInvitation, inviteMember, signIn } from "./client-api";

describe("browser auth API", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("signs in with credentialed browser requests", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ member: { email: "admin@example.com", role: "admin" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(signIn("admin@example.com", "admin-password")).resolves.toMatchObject({ role: "admin" });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/auth/sign-in", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "admin-password" }),
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
