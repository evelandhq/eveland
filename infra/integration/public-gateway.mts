import { createGatewayApp } from "../../apps/gateway/src/app.js";

/**
 * An in-process Agent Gateway over the smoke's store, for requests a smoke
 * sends to a project's public URL (an OAuth redirect, a remote agent's
 * callback). The Host is taken from the URL, as a browser or a remote
 * deployment would send it.
 */
export function startPublicGateway(
  store: Parameters<typeof createGatewayApp>[0],
  options: { allowedBaseDomains: string[] },
): { request: (url: string, init?: RequestInit) => Promise<Response> } {
  const gateway = createGatewayApp(store, {
    allowedBaseDomains: options.allowedBaseDomains,
    affinitySecret: "public-gateway-smoke-affinity-secret",
    routeCacheTtlMs: 0,
  });
  return {
    request: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", new URL(url).host);
      return gateway.request(url, { ...init, headers });
    },
  };
}
