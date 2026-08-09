import { describe, expect, test, vi } from "vitest";
import { createGatewayApp } from "./app.js";
import {
  affinitySecret,
  registerGatewayTestCleanup,
  repository,
  route,
  startUpstream,
} from "./app.test-support.js";

registerGatewayTestCleanup();

const eveStreamHeaders = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "x-eve-stream-format": "ndjson",
};

describe("Gateway stream idle handling", () => {
  test("ends an idle session stream with a clean EOF instead of an abort", async () => {
    let markClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      response.once("close", markClosed);
      response.writeHead(200, eveStreamHeaders);
      response.write('{"type":"turn.started"}\n');
      // A session stream is legitimately silent between turns: no more writes.
    });
    const activationClient = {
      activate: vi.fn(async () => ({ leaseId: "lease_stream", endpointPort: upstream.port })),
      renew: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      upstreamTimeoutMs: 120,
      activationClient,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_1/stream",
      { headers: { host: "p-alpha.agent.localhost" } },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("turn.started");
    // The idle reap must surface downstream as a normal end of stream -- a
    // clean chunked terminator survives every proxy hop, while an abort is
    // what wedged the Playground when the dev proxy failed to propagate it.
    const second = await reader.read();
    expect(second.done).toBe(true);
    await expect(
      Promise.race([
        upstreamClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("upstream socket survived the idle reap")), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(activationClient.release).toHaveBeenCalledWith("lease_stream");
    });
  });

  test("keeps aborting a non-stream upstream body that exceeds the idle timeout", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      // Never completes: a wedged deployment mid-response.
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      upstreamTimeoutMs: 120,
    });

    const response = await app.request("http://p-alpha.agent.localhost/slow", {
      headers: { host: "p-alpha.agent.localhost" },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("partial");
    await expect(reader.read()).rejects.toThrow();
  });

  test("injects NDJSON heartbeat newlines while an eve stream is idle", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, eveStreamHeaders);
      response.write('{"type":"turn.started"}\n');
      setTimeout(() => response.end('{"type":"session.waiting"}\n'), 250);
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      upstreamTimeoutMs: 5_000,
      streamHeartbeatMs: 40,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_1/stream",
      { headers: { host: "p-alpha.agent.localhost" } },
    );
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const reader = response.body!.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(decoder.decode(chunk.value));
    }
    const joined = chunks.join("");
    expect(joined).toContain("turn.started");
    expect(joined).toContain("session.waiting");
    expect(chunks.filter((chunk) => chunk === "\n").length).toBeGreaterThanOrEqual(2);
    // Heartbeats must be invisible to an NDJSON consumer: every non-empty
    // line still parses (eve's reader skips blank lines).
    for (const line of joined.split("\n")) {
      if (line.trim().length > 0) JSON.parse(line);
    }
  });

  test("does not inject heartbeats into a stream response without eve's format marker", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      response.write('{"type":"turn.started"}\n');
      setTimeout(() => response.end('{"type":"session.waiting"}\n'), 150);
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      upstreamTimeoutMs: 5_000,
      streamHeartbeatMs: 30,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_1/stream",
      { headers: { host: "p-alpha.agent.localhost" } },
    );
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const reader = response.body!.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(decoder.decode(chunk.value));
    }
    expect(chunks.some((chunk) => chunk === "\n")).toBe(false);
  });

  test("cancelling a heartbeat-wrapped stream still tears down the upstream promptly", async () => {
    let markClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      response.once("close", markClosed);
      response.writeHead(200, eveStreamHeaders);
      response.write('{"type":"turn.started"}\n');
    });
    const app = createGatewayApp(repository([route({ hostPort: upstream.port })]), {
      allowedBaseDomains: ["agent.localhost"],
      affinitySecret,
      upstreamTimeoutMs: 5_000,
      streamHeartbeatMs: 40,
    });

    const response = await app.request(
      "http://p-alpha.agent.localhost/eve/v1/session/eve_1/stream",
      { headers: { host: "p-alpha.agent.localhost" } },
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await expect(
      Promise.race([
        upstreamClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("upstream stream stayed open")), 300),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});
