import { ApiError, apiRequest, type FetchLike } from "./api-client.ts";

/**
 * RFC 8628 device authorization against an eveland instance. The server side
 * (better-auth device plugin + oauth provider) owns the state machine; this
 * client requests a code, sends the user to the Dashboard's /device page, and
 * polls the token endpoint honoring interval and slow_down.
 */

export const EVELAND_CLI_CLIENT_ID = "eveland-cli";
export const CLI_REQUESTED_SCOPE = "deploy observe";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type TokenResponse = {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
};

export type DeviceFlowIo = {
  fetchImpl?: FetchLike;
  /** Prints user-facing progress lines. */
  print: (line: string) => void;
  /** Best-effort browser opener; failures are tolerated silently. */
  openUrl?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type DeviceFlowResult = {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  expiresAt: string | null;
  obtainedAt: string;
};

export async function runDeviceFlow(origin: string, io: DeviceFlowIo): Promise<DeviceFlowResult> {
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = io.now ?? Date.now;

  let issued: DeviceCodeResponse;
  try {
    issued = await apiRequest<DeviceCodeResponse>({
      origin,
      path: "/api/auth/device/code",
      json: { client_id: EVELAND_CLI_CLIENT_ID, scope: CLI_REQUESTED_SCOPE },
      fetchImpl: io.fetchImpl,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new Error(
        `${origin} does not offer device authorization — the instance predates CLI login (upgrade it) or the origin is not an eveland instance.`,
      );
    }
    throw error;
  }

  io.print(`Confirm this code in your browser: ${issued.user_code}`);
  io.print(`Approval page: ${issued.verification_uri_complete}`);
  await io.openUrl?.(issued.verification_uri_complete).catch(() => {});
  io.print("Waiting for approval...");

  const deadline = now() + issued.expires_in * 1_000;
  let intervalMs = Math.max(issued.interval, 1) * 1_000;
  for (;;) {
    if (now() >= deadline) {
      throw new Error(
        "The login request expired before it was approved. Run `eveland login` again.",
      );
    }
    await sleep(intervalMs);
    let token: TokenResponse;
    try {
      token = await apiRequest<TokenResponse>({
        origin,
        path: "/api/auth/oauth2/token",
        form: {
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: issued.device_code,
          client_id: EVELAND_CLI_CLIENT_ID,
        },
        fetchImpl: io.fetchImpl,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "authorization_pending") continue;
        if (error.code === "slow_down") {
          // RFC 8628 §3.5: add 5 seconds to the interval.
          intervalMs += 5_000;
          continue;
        }
        if (error.code === "expired_token") {
          throw new Error(
            "The login request expired before it was approved. Run `eveland login` again.",
          );
        }
        if (error.code === "access_denied") {
          throw new Error("The login request was denied in the Dashboard.");
        }
      }
      throw error;
    }
    const obtainedAt = new Date(now());
    return {
      accessToken: token.access_token,
      tokenType: token.token_type,
      scopes: token.scope.split(" ").filter(Boolean),
      expiresAt: token.expires_in
        ? new Date(obtainedAt.getTime() + token.expires_in * 1_000).toISOString()
        : null,
      obtainedAt: obtainedAt.toISOString(),
    };
  }
}
