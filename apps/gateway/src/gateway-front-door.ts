import { classifyFrontDoorPath } from "@evelandhq/core/front-door";

export type FrontDoorUpstreams = {
  /** Private API origin (browser API, Better Auth, issuer documents). */
  apiUrl: string;
  /** Private Dashboard origin (everything else on the platform host). */
  webUrl: string;
  fetchImplementation?: typeof fetch;
};

/**
 * Hop-by-hop headers never cross a proxy; `accept-encoding` is forced to
 * identity instead of forwarded because undici transparently decompresses
 * upstream bodies (and drops the header), which would corrupt a re-served
 * compressed response — the upstreams are loopback, compression buys nothing.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
  "host",
  // Client-supplied forwarding headers are stripped and rebuilt below: the
  // API rate-limits the unauthenticated device-code endpoint by
  // x-forwarded-for, so the value must be gateway-owned — a client-chosen
  // one would let an attacker mint a fresh rate-limit bucket per request.
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

/**
 * Serves a platform-host request at the front door: `/.well-known/*` and
 * `/api/*` go to the API verbatim, everything else is the Dashboard's. No
 * path surgery in either direction. Streaming passes through untouched —
 * the Playground's SSE and NDJSON responses ride this path.
 */
export async function proxyFrontDoorRequest(
  request: Request,
  upstreams: FrontDoorUpstreams,
  remoteIp?: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const route = classifyFrontDoorPath(url.pathname);
  const origin = (route.target === "api" ? upstreams.apiUrl : upstreams.webUrl).replace(/\/$/, "");
  const upstreamUrl = `${origin}${route.upstreamPath}${url.search}`;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));
  // Gateway-owned client identity: the API's device-code throttle keys on
  // this value, so it must be the observed socket peer, never client input.
  headers.set("x-forwarded-for", remoteIp ?? "unknown");

  const fetchImplementation = upstreams.fetchImplementation ?? fetch;
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  const upstream = await fetchImplementation(upstreamUrl, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // Redirects (auth flows, Next route normalization) belong to the browser.
    redirect: "manual",
    // A proxy never negotiates credentials of its own -- cookies and
    // `authorization` ride through as forwarded headers either way. At the
    // default, undici answers an upstream 401 by re-sending the request with
    // credentials attached, and that retry starts by re-extracting the body
    // source, which a forwarded stream does not have: every 401 on a request
    // WITH a body then dies as `fetch failed: expected non-null body source`
    // and reaches the browser as a 500 instead of the 401 the API sent.
    credentials: "omit",
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower) || lower === "set-cookie") continue;
    responseHeaders.append(name, value);
  }
  // set-cookie folds when iterated as a plain header; copy each one intact.
  const withGetSetCookie = upstream.headers as Headers & { getSetCookie?: () => string[] };
  for (const cookie of withGetSetCookie.getSetCookie?.() ?? []) {
    responseHeaders.append("set-cookie", cookie);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
