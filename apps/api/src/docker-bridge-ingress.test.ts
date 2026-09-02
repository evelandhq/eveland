import { describe, expect, test, vi } from "vitest";
import { createDockerBridgeIngress, resolveDockerBridgeBindHost } from "./docker-bridge-ingress.js";

describe("Docker bridge API ingress", () => {
  test("is disabled unless a private bridge address is configured", () => {
    expect(resolveDockerBridgeBindHost({})).toBeUndefined();
    expect(resolveDockerBridgeBindHost({ EVELAND_API_DOCKER_BRIDGE_HOST: "172.17.0.1" })).toBe(
      "172.17.0.1",
    );
  });

  test.each(["0.0.0.0", "127.0.0.1", "8.8.8.8", "host.docker.internal"])(
    "rejects unsafe bind host %s",
    (host) => {
      expect(() => resolveDockerBridgeBindHost({ EVELAND_API_DOCKER_BRIDGE_HOST: host })).toThrow(
        /private Docker bridge IPv4 address/,
      );
    },
  );

  test("rejects a primary API listener that already covers the bridge", () => {
    expect(() =>
      resolveDockerBridgeBindHost({
        EVELAND_API_BIND_HOST: "0.0.0.0",
        EVELAND_API_DOCKER_BRIDGE_HOST: "172.17.0.1",
      }),
    ).toThrow(/separate loopback EVELAND_API_BIND_HOST/);
  });

  test("rejects the bridge listener in production", () => {
    expect(() =>
      resolveDockerBridgeBindHost({
        NODE_ENV: "production",
        EVELAND_API_DOCKER_BRIDGE_HOST: "172.17.0.1",
      }),
    ).toThrow(/only supported for Linux native development/);
  });

  test.each([
    ["GET", "/health"],
    ["POST", "/internal/otel/v1/logs"],
    ["POST", "/internal/otel/v1/metrics"],
    ["POST", "/internal/observability/destinations/dst_1/v1/logs"],
    ["GET", "/.well-known/jwks.json"],
    ["POST", "/internal/scheduler/dispatch"],
  ])("forwards %s %s to the API", async (method, pathname) => {
    const apiFetch = vi.fn(async () => new Response("accepted", { status: 202 }));
    const ingress = createDockerBridgeIngress(apiFetch);
    const request = new Request(`http://172.17.0.1:17301${pathname}`, { method });

    const response = await ingress(request);

    expect(response.status).toBe(202);
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(apiFetch).toHaveBeenCalledWith(request);
  });

  test.each([
    "/api/projects",
    "/internal/scheduler/dispatch/extra",
    "/.well-known/jwks.json/extra",
    "/internal/otel-malicious/v1/logs",
  ])("returns 404 without forwarding %s", async (pathname) => {
    const apiFetch = vi.fn(async () => new Response("unexpected"));
    const ingress = createDockerBridgeIngress(apiFetch);

    const response = await ingress(new Request(`http://172.17.0.1:17301${pathname}`));

    expect(response.status).toBe(404);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
