import { describe, expect, test } from "vitest";
import { buildForwardHeaders, filterUpstreamResponseHeaders } from "./headers.js";

describe("buildForwardHeaders", () => {
  test("strips hop-by-hop headers and headers named by Connection", () => {
    const headers = buildForwardHeaders({
      requestHeaders: {
        host: "demo.lvh.me:8080",
        connection: "keep-alive, x-custom-hop",
        "keep-alive": "timeout=5",
        te: "trailers",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        "proxy-authorization": "secret",
        "x-custom-hop": "drop-me",
        accept: "application/x-ndjson",
      },
      clientAddress: "203.0.113.7",
      originalHost: "demo.lvh.me:8080",
    });
    expect(headers.accept).toBe("application/x-ndjson");
    for (const gone of ["connection", "keep-alive", "te", "transfer-encoding", "upgrade", "proxy-authorization", "x-custom-hop"]) {
      expect(headers[gone]).toBeUndefined();
    }
  });

  test("preserves the original Host and synthesizes x-forwarded-*", () => {
    const headers = buildForwardHeaders({
      requestHeaders: { host: "demo.lvh.me:8080" },
      clientAddress: "203.0.113.7",
      originalHost: "demo.lvh.me:8080",
    });
    expect(headers.host).toBe("demo.lvh.me:8080");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers["x-forwarded-host"]).toBe("demo.lvh.me:8080");
  });

  test("appends to an existing x-forwarded-for and passes ingress-set values through", () => {
    const headers = buildForwardHeaders({
      requestHeaders: {
        host: "demo.lvh.me",
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "demo.jinshujuagents.com",
      },
      clientAddress: "203.0.113.7",
      originalHost: "demo.lvh.me",
    });
    expect(headers["x-forwarded-for"]).toBe("198.51.100.1, 203.0.113.7");
    expect(headers["x-forwarded-proto"]).toBe("https");
    expect(headers["x-forwarded-host"]).toBe("demo.jinshujuagents.com");
  });
});

describe("filterUpstreamResponseHeaders", () => {
  test("drops hop-by-hop response headers, keeps the rest", () => {
    const filtered = filterUpstreamResponseHeaders({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "content-type": "application/x-ndjson",
      "x-agent": "yes",
    });
    expect(filtered["content-type"]).toBe("application/x-ndjson");
    expect(filtered["x-agent"]).toBe("yes");
    expect(filtered.connection).toBeUndefined();
    expect(filtered["transfer-encoding"]).toBeUndefined();
  });
});
