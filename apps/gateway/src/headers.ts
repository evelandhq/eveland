import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

export function buildForwardHeaders(input: {
  requestHeaders: IncomingHttpHeaders;
  clientAddress: string;
  originalHost: string;
}): OutgoingHttpHeaders {
  const dropped = connectionNamedHeaders(input.requestHeaders);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(input.requestHeaders)) {
    if (value === undefined || HOP_BY_HOP.has(name) || dropped.has(name)) {
      continue;
    }
    headers[name] = value;
  }

  headers.host = input.originalHost;
  const existingForwardedFor = input.requestHeaders["x-forwarded-for"];
  headers["x-forwarded-for"] = existingForwardedFor ? `${String(existingForwardedFor)}, ${input.clientAddress}` : input.clientAddress;
  headers["x-forwarded-proto"] = input.requestHeaders["x-forwarded-proto"] ?? "http";
  headers["x-forwarded-host"] = input.requestHeaders["x-forwarded-host"] ?? input.originalHost;
  return headers;
}

export function filterUpstreamResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const dropped = connectionNamedHeaders(headers);
  const filtered: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || dropped.has(name)) {
      continue;
    }
    filtered[name] = value;
  }
  return filtered;
}

function connectionNamedHeaders(headers: IncomingHttpHeaders): Set<string> {
  const values = headers.connection;
  const tokens = Array.isArray(values) ? values.join(",") : values ?? "";
  return new Set(
    tokens
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}
