import { Hono } from "hono";
import { describe, expect, test } from "vitest";

import { authErrorResponse } from "./app-support.js";
import { AuthFlowError } from "./auth.js";

function respond(error: unknown) {
  const app = new Hono();
  app.get("/x", (c) => authErrorResponse(c, error));
  return app.request("http://local/x");
}

describe("auth error -> HTTP status mapping", () => {
  test("a typed AuthFlowError carries its own status", async () => {
    const response = await respond(new AuthFlowError("Cannot demote the last admin", 409));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Cannot demote the last admin",
    });
  });

  test("an upstream Better Auth APIError is mapped by its statusCode, not its prose", async () => {
    const upstream = Object.assign(new Error("Session expired for this operation"), {
      statusCode: 401,
    });
    const response = await respond(upstream);
    expect(response.status).toBe(401);
  });

  test("upstream prose cannot choose the status", async () => {
    // Only typed errors map to a status; an untyped error falls through to 400
    // regardless of wording, so a reworded upstream message that happens to
    // say "not found" cannot become a 404.
    const response = await respond(new Error("route not found in upstream"));
    expect(response.status).toBe(400);
    const conflictProse = await respond(new Error("cannot touch the last admin"));
    expect(conflictProse.status).toBe(400);
  });
});
