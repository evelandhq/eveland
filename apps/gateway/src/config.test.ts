import { describe, expect, test } from "vitest";
import { loadGatewayConfig } from "./config.js";

describe("loadGatewayConfig", () => {
  const validEnv = {
    DATABASE_URL: "postgres://eveland:eveland@localhost:5432/eveland",
    EVELAND_AGENT_DOMAIN: "LVH.me.",
  } as NodeJS.ProcessEnv;

  test("applies defaults and normalizes the domain", () => {
    const config = loadGatewayConfig(validEnv);
    expect(config).toMatchObject({
      port: 8080,
      agentDomain: "lvh.me",
      upstreamTimeoutMs: 30_000,
      routeTtlMs: 30_000,
      upstreamHostOverride: null,
    });
    expect(config.agentUrlEnv.EVELAND_AGENT_DOMAIN).toBe("lvh.me");
  });

  test("reads overrides", () => {
    const config = loadGatewayConfig({
      ...validEnv,
      PORT: "9090",
      EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS: "5000",
      EVELAND_GATEWAY_ROUTE_TTL_MS: "1000",
      EVELAND_GATEWAY_UPSTREAM_HOST: "host.docker.internal",
      EVELAND_AGENT_URL_SCHEME: "https",
      EVELAND_AGENT_URL_PORT: "8443",
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ port: 9090, upstreamTimeoutMs: 5000, routeTtlMs: 1000, upstreamHostOverride: "host.docker.internal" });
    expect(config.agentUrlEnv).toEqual({
      EVELAND_AGENT_DOMAIN: "lvh.me",
      EVELAND_AGENT_URL_SCHEME: "https",
      EVELAND_AGENT_URL_PORT: "8443",
    });
  });

  test("EVELAND_GATEWAY_PORT wins over the shared PORT", () => {
    const config = loadGatewayConfig({
      ...validEnv,
      PORT: "4000",
      EVELAND_GATEWAY_PORT: "8090",
    } as NodeJS.ProcessEnv);
    expect(config.port).toBe(8090);
  });

  test("rejects an invalid EVELAND_GATEWAY_PORT", () => {
    expect(() =>
      loadGatewayConfig({ ...validEnv, EVELAND_GATEWAY_PORT: "70000" } as NodeJS.ProcessEnv),
    ).toThrow(/EVELAND_GATEWAY_PORT/);
  });

  test("aggregates every missing required variable into one error", () => {
    expect(() => loadGatewayConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL[\s\S]*EVELAND_AGENT_DOMAIN/);
  });

  test("aggregates invalid numeric, domain, scheme, and URL port settings", () => {
    let error: unknown;
    try {
      loadGatewayConfig({
        DATABASE_URL: "postgres://eveland:eveland@localhost:5432/eveland",
        EVELAND_AGENT_DOMAIN: "https://bad domain:5432",
        PORT: "Infinity",
        EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS: "0",
        EVELAND_GATEWAY_ROUTE_TTL_MS: "-1",
        EVELAND_AGENT_URL_SCHEME: "ftp",
        EVELAND_AGENT_URL_PORT: "70000",
      } as NodeJS.ProcessEnv);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = String((error as Error).message);
    for (const name of [
      "PORT",
      "EVELAND_AGENT_DOMAIN",
      "EVELAND_AGENT_URL_SCHEME",
      "EVELAND_AGENT_URL_PORT",
      "EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS",
      "EVELAND_GATEWAY_ROUTE_TTL_MS",
    ]) {
      expect(message).toContain(name);
    }
  });
});
