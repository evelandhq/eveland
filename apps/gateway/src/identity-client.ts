import type { GatewayIdentityClient } from "./gateway-types.js";

/** Refresh this far before expiry so a token is never handed out on its edge. */
const REFRESH_MARGIN_MS = 60_000;
/** Floor between mint attempts after a transient failure. */
const RETRY_MS = 5_000;
/**
 * Floor after the control API reports open access is not the enabled Provider.
 * That is a stable configuration state rather than an outage, so an instance
 * running Eveland Internal must not ask again on every public request.
 */
const INACTIVE_RETRY_MS = 60_000;

type CacheEntry = {
  token: string;
  expiresAt: number;
  refreshAt: number;
};

/**
 * Mints and caches open-access Caller Tokens, one per Project.
 *
 * A Caller Token is audience-bound to a single Project
 * (`aud=eveland:project:<id>`), so there is no platform-wide token to cache --
 * every Project needs its own. Entries are refreshed ahead of expiry and
 * deduplicated per Project, so a burst of concurrent requests for a cold
 * Project produces one mint rather than one per request.
 */
export function createApiIdentityClient(input: {
  apiUrl: string;
  serviceToken: string;
  maxEntries?: number;
  now?: () => number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): GatewayIdentityClient {
  const apiUrl = input.apiUrl.replace(/\/$/, "");
  const maxEntries = input.maxEntries ?? 1_000;
  const now = input.now ?? (() => Date.now());
  const fetcher = input.fetch ?? fetch;
  const headers = {
    authorization: `Bearer ${input.serviceToken}`,
    "content-type": "application/json",
  };
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<string | null>>();
  const retryAfter = new Map<string, number>();

  function readFresh(projectId: string): string | null {
    const entry = cache.get(projectId);
    if (!entry) return null;
    const current = now();
    if (entry.expiresAt <= current) {
      cache.delete(projectId);
      return null;
    }
    // Bounded LRU: re-inserting moves the entry to the end of the Map's
    // insertion order, which is what makes the eviction below evict the
    // least recently used Project rather than the oldest-minted one.
    cache.delete(projectId);
    cache.set(projectId, entry);
    return entry.refreshAt > current ? entry.token : null;
  }

  async function mint(projectId: string): Promise<{ token: string | null; inactive: boolean }> {
    const response = await fetcher(`${apiUrl}/internal/identity/open-caller-tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId }),
    });
    // 409 is the control API saying open access is switched off. Treated as a
    // steady state, not an error, so the Gateway stops asking rather than
    // polling the mint route once per request forever.
    if (!response.ok) return { token: null, inactive: response.status === 409 };
    const value = (await response.json().catch(() => null)) as {
      token?: unknown;
      expiresAt?: unknown;
    } | null;
    if (typeof value?.token !== "string" || typeof value.expiresAt !== "string") {
      return { token: null, inactive: false };
    }
    const expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAt)) return { token: null, inactive: false };

    cache.set(projectId, {
      token: value.token,
      expiresAt,
      refreshAt: expiresAt - REFRESH_MARGIN_MS,
    });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    return { token: value.token, inactive: false };
  }

  return {
    async callerToken(projectId) {
      const fresh = readFresh(projectId);
      if (fresh) return fresh;

      const pending = inflight.get(projectId);
      if (pending) return pending;

      const blockedUntil = retryAfter.get(projectId) ?? 0;
      if (now() < blockedUntil) return readUnexpired(projectId);

      const attempt = mint(projectId)
        .catch(() => ({ token: null, inactive: false }))
        .then((result) => {
          if (result.token) {
            retryAfter.delete(projectId);
            return result.token;
          }
          retryAfter.set(projectId, now() + (result.inactive ? INACTIVE_RETRY_MS : RETRY_MS));
          // Open access switched off: drop what is cached rather than keep
          // injecting an anonymous identity an administrator just took away.
          if (result.inactive) {
            cache.delete(projectId);
            return null;
          }
          // Otherwise a stale-but-unexpired token still verifies at the Agent,
          // which beats sending nothing while the Identity service is down.
          return readUnexpired(projectId);
        })
        .finally(() => inflight.delete(projectId));
      inflight.set(projectId, attempt);
      return attempt;
    },
  };

  function readUnexpired(projectId: string): string | null {
    const entry = cache.get(projectId);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(projectId);
      return null;
    }
    return entry.token;
  }
}
