import { afterEach, describe, expect, test, vi } from "vitest";
import { createApiIdentityClient } from "./identity-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const apiUrl = "http://api.internal:4000";

describe("Gateway identity client", () => {
  test("caches one token per Project rather than one for the platform", async () => {
    const fetchMock = mintingFetch();
    const client = createApiIdentityClient({ apiUrl, serviceToken: "svc", fetch: fetchMock });

    await expect(client.callerToken("proj_a")).resolves.toBe("token:proj_a");
    await expect(client.callerToken("proj_b")).resolves.toBe("token:proj_b");
    await expect(client.callerToken("proj_a")).resolves.toBe("token:proj_a");

    // A Caller Token is audience-bound to one Project, so a single cached
    // token would 401 at every Project but the first -- and silently, because
    // an audience mismatch is indistinguishable from "not our token".
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies(fetchMock)).toEqual([{ projectId: "proj_a" }, { projectId: "proj_b" }]);
  });

  test("mints once for a burst of concurrent requests on a cold Project", async () => {
    const fetchMock = mintingFetch();
    const client = createApiIdentityClient({ apiUrl, serviceToken: "svc", fetch: fetchMock });

    const tokens = await Promise.all([
      client.callerToken("proj_a"),
      client.callerToken("proj_a"),
      client.callerToken("proj_a"),
    ]);

    expect(tokens).toEqual(["token:proj_a", "token:proj_a", "token:proj_a"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("refreshes ahead of expiry instead of on it", async () => {
    let current = Date.parse("2029-01-01T00:00:00.000Z");
    const fetchMock = mintingFetch(() => current + 20 * 60_000);
    const client = createApiIdentityClient({
      apiUrl,
      serviceToken: "svc",
      fetch: fetchMock,
      now: () => current,
    });

    await client.callerToken("proj_a");
    current += 18 * 60_000;
    await client.callerToken("proj_a");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Inside the last minute of its life the token is replaced, so a request
    // is never handed a credential that expires while it is in flight.
    current += 90_000;
    await client.callerToken("proj_a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keeps serving an unexpired token while minting is failing", async () => {
    let current = Date.parse("2029-01-01T00:00:00.000Z");
    let healthy = true;
    const fetchMock = vi.fn(async () =>
      healthy
        ? Response.json({
            token: "token:proj_a",
            expiresAt: new Date(current + 20 * 60_000).toISOString(),
          })
        : new Response("upstream failure", { status: 503 }),
    );
    const client = createApiIdentityClient({
      apiUrl,
      serviceToken: "svc",
      fetch: fetchMock,
      now: () => current,
    });

    await client.callerToken("proj_a");
    healthy = false;
    current += 19 * 60_000 + 30_000;
    await expect(client.callerToken("proj_a")).resolves.toBe("token:proj_a");

    // Past its expiry there is nothing usable left to serve.
    current += 60_000;
    await expect(client.callerToken("proj_a")).resolves.toBeNull();
  });

  test("stops asking, and drops what it cached, once open access is switched off", async () => {
    let current = Date.parse("2029-01-01T00:00:00.000Z");
    let open = true;
    const fetchMock = vi.fn(async () =>
      open
        ? Response.json({
            token: "token:proj_a",
            expiresAt: new Date(current + 20 * 60_000).toISOString(),
          })
        : new Response("open access inactive", { status: 409 }),
    );
    const client = createApiIdentityClient({
      apiUrl,
      serviceToken: "svc",
      fetch: fetchMock,
      now: () => current,
    });

    await client.callerToken("proj_a");
    open = false;
    current += 19 * 60_000 + 30_000;

    // An administrator deliberately took the anonymous identity away, so the
    // cached token must not carry on standing in for it.
    await expect(client.callerToken("proj_a")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // And a configured-off platform is a steady state, not an outage: the
    // Gateway must not re-ask on every public request forever.
    current += 1_000;
    await expect(client.callerToken("proj_a")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("bounds the cache so unknown-Project traffic cannot grow it without limit", async () => {
    const fetchMock = mintingFetch();
    const client = createApiIdentityClient({
      apiUrl,
      serviceToken: "svc",
      fetch: fetchMock,
      maxEntries: 2,
    });

    await client.callerToken("proj_a");
    await client.callerToken("proj_b");
    await client.callerToken("proj_a");
    await client.callerToken("proj_c");

    // proj_b is the least recently used, so it is the one evicted -- proj_a
    // was touched after it and is still cached.
    await client.callerToken("proj_a");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await client.callerToken("proj_b");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

function mintingFetch(expiresAt: () => number = () => Date.now() + 20 * 60_000) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { projectId } = JSON.parse(String(init?.body ?? "{}")) as { projectId: string };
    return Response.json({
      token: `token:${projectId}`,
      expiresAt: new Date(expiresAt()).toISOString(),
    });
  });
}

function bodies(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit)?.body ?? "{}")));
}
