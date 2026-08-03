import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import {
  parseObservabilityPrivateHostAllowlist,
  requestExternalObservabilityDestination,
  validateExternalObservabilityDestination,
} from "./observability.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("external observability destination network policy", () => {
  test.each([
    { address: "8.8.8.8", family: 4 as const },
    { address: "2606:4700:4700::1111", family: 6 as const },
  ])("allows public resolved address $address", async ({ address, family }) => {
    await expect(
      validateExternalObservabilityDestination(
        {
          kind: "custom_otlp",
          endpoint: "https://collector.example",
          supportedSignals: ["logs"],
          domains: ["agent"],
          headers: {},
        },
        {
          lookup: async () => [{ address, family }],
        },
      ),
    ).resolves.toBeUndefined();
  });

  test("requires public destinations to use HTTPS", async () => {
    await expect(
      validateExternalObservabilityDestination(
        {
          kind: "custom_otlp",
          endpoint: "http://collector.example",
          supportedSignals: ["logs"],
          domains: ["agent"],
          headers: {},
        },
        {
          lookup: async () => [{ address: "1.1.1.1", family: 4 }],
        },
      ),
    ).rejects.toThrow(/HTTPS/);
  });

  test.each(["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1", "::ffff:8.8.8.8"])(
    "rejects non-public resolved address %s by default",
    async (address) => {
      await expect(
        validateExternalObservabilityDestination(
          {
            kind: "elastic",
            endpoint: "https://collector.example",
            authorization: { type: "bearer", value: "secret" },
          },
          {
            lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
          },
        ),
      ).rejects.toThrow(/public IP/);
    },
  );

  test("allows an explicitly listed private HTTP destination", async () => {
    await expect(
      validateExternalObservabilityDestination(
        {
          kind: "custom_otlp",
          endpoint: "http://collector.internal:4318",
          supportedSignals: ["metrics"],
          domains: ["capacity"],
          headers: {},
        },
        {
          privateHostAllowlist: new Set(["collector.internal"]),
          lookup: async () => [{ address: "10.0.0.8", family: 4 }],
        },
      ),
    ).resolves.toBeUndefined();
    expect(
      parseObservabilityPrivateHostAllowlist(" collector.internal,10.0.0.8,collector.internal "),
    ).toEqual(new Set(["collector.internal", "10.0.0.8"]));
  });

  test("pins the validated address, preserves Host, and does not follow redirects", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.headers.host} ${request.url}`);
      response.writeHead(307, { location: "/metadata" });
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server.");
    }

    const result = await requestExternalObservabilityDestination({
      config: {
        kind: "custom_otlp",
        endpoint: `http://collector.internal:${address.port}`,
        supportedSignals: ["logs"],
        domains: ["agent"],
        headers: {},
      },
      signal: "logs",
      contentType: "application/json",
      body: new TextEncoder().encode('{"resourceLogs":[]}'),
      privateHostAllowlist: new Set(["collector.internal"]),
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    expect(result.status).toBe(307);
    expect(requests).toEqual([`collector.internal:${address.port} /v1/logs`]);
  });
});
