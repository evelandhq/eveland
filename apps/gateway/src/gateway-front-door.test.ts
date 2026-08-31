import { describe, expect, test, vi } from "vitest";
import { proxyFrontDoorRequest } from "./gateway-front-door.js";

function upstreams(fetchImplementation: typeof fetch) {
  return {
    apiUrl: "http://127.0.0.1:17301",
    webUrl: "http://127.0.0.1:17302",
    fetchImplementation,
  };
}

describe("front-door proxy", () => {
  test("routes the /api namespace to the API verbatim, query preserved", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    await proxyFrontDoorRequest(
      new Request("http://localhost:17300/api/projects/proj_1?full=1"),
      upstreams(fetchMock as unknown as typeof fetch),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:17301/api/projects/proj_1?full=1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("routes Better Auth and issuer documents to the API verbatim", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const proxy = upstreams(fetchMock as unknown as typeof fetch);
    await proxyFrontDoorRequest(
      new Request("http://localhost:17300/api/auth/sign-in/email"),
      proxy,
    );
    await proxyFrontDoorRequest(new Request("http://localhost:17300/.well-known/jwks.json"), proxy);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:17301/api/auth/sign-in/email",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:17301/.well-known/jwks.json",
      expect.anything(),
    );
  });

  test("never forwards the machine plane to the API", async () => {
    // Root /internal is the Dashboard's side of the classifier here (the real
    // Gateway answers it with its own service-token gate before path routing),
    // so the API upstream can never see it through the front door.
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    await proxyFrontDoorRequest(
      new Request("http://localhost:17300/internal/scheduler/dispatch"),
      upstreams(fetchMock as unknown as typeof fetch),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:17302/internal/scheduler/dispatch",
      expect.anything(),
    );
  });

  test("falls through to the Dashboard for page traffic", async () => {
    const fetchMock = vi.fn(async () => new Response("<html/>", { status: 200 }));
    await proxyFrontDoorRequest(
      new Request("http://localhost:17300/projects/proj_1"),
      upstreams(fetchMock as unknown as typeof fetch),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:17302/projects/proj_1",
      expect.anything(),
    );
  });

  test("forwards identity headers and strips hop-by-hop ones", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await proxyFrontDoorRequest(
      new Request("http://localhost:17300/login", {
        headers: {
          cookie: "eveland_session=abc",
          connection: "keep-alive",
          "accept-encoding": "gzip",
        },
      }),
      upstreams(fetchMock as unknown as typeof fetch),
    );
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Headers;
    expect(headers.get("cookie")).toBe("eveland_session=abc");
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("accept-encoding")).toBeNull();
    expect(headers.get("x-forwarded-host")).toBe("localhost:17300");
    expect(headers.get("x-forwarded-proto")).toBe("http");
  });

  test("passes redirects and set-cookie headers through untouched", async () => {
    const upstreamHeaders = new Headers({ location: "/login" });
    upstreamHeaders.append("set-cookie", "a=1; Path=/");
    upstreamHeaders.append("set-cookie", "b=2; Path=/");
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 307, headers: upstreamHeaders }),
    );
    const response = await proxyFrontDoorRequest(
      new Request("http://localhost:17300/api/auth/sign-out", { method: "POST" }),
      upstreams(fetchMock as unknown as typeof fetch),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login");
    const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
    expect(withGetSetCookie.getSetCookie?.()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});
