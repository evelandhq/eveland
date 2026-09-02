import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FetchLike } from "./io.ts";

/**
 * First-boot implicit login: mint a scoped CLI token for this machine's
 * `eveland` CLI so the golden path (init -> deploy) never hits a login wall.
 *
 * This is the exact RFC 8628 device flow the CLI runs — the same seeded
 * public client, the same scopes, the same token shape — except the approval
 * step is driven headlessly with the admin session the bootstrap itself just
 * seeded, over the loopback API. Nothing here bypasses the auth model: the
 * resulting token is a normal scoped, revocable device-flow token that shows
 * up in the Dashboard like any other.
 */

export const EVELAND_CLI_CLIENT_ID = "eveland-cli";
export const CLI_REQUESTED_SCOPE = "deploy observe";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_TOKEN_POLLS = 6;

export type ImplicitLoginOptions = {
  /** Loopback API base (the public origin may not resolve locally on a headless box). */
  apiBaseUrl: string;
  /** The origin the credential is stored under — what `eveland` resolves via EVELAND_HOME. */
  publicOrigin: string;
  adminEmail: string;
  adminPassword: string;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
  print: (line: string) => void;
};

export type ImplicitLoginResult = {
  credentialPath: string;
  scopes: string[];
  /** For the bootstrap's own follow-up CLI calls (seeding); never logged. */
  accessToken: string;
};

class LoginStepError extends Error {
  constructor(step: string, status: number, body: string) {
    super(`Implicit CLI login failed at ${step} (HTTP ${status}): ${body.slice(0, 300)}`);
  }
}

async function requestJson<T>(
  options: ImplicitLoginOptions,
  step: string,
  input: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ data: T; response: Response }> {
  const response = await options.fetchImpl(`${options.apiBaseUrl}${input.path}`, {
    method: input.method ?? "GET",
    headers: { origin: options.publicOrigin, ...input.headers },
    body: input.body,
  });
  const text = await response.text();
  if (!response.ok) throw new LoginStepError(step, response.status, text);
  return { data: (text ? JSON.parse(text) : {}) as T, response };
}

export function credentialFilePath(publicOrigin: string, env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(
    configHome,
    "eveland",
    "credentials",
    `${encodeURIComponent(publicOrigin)}.json`,
  );
}

async function writeCredential(
  publicOrigin: string,
  env: NodeJS.ProcessEnv,
  credential: {
    accessToken: string;
    tokenType: string;
    scopes: string[];
    obtainedAt: string;
    expiresAt: string | null;
  },
): Promise<string> {
  // Mirrors the eveland CLI's store contract (packages/cli/src/credentials.ts):
  // one file per origin, 0700 dir, 0600 file, temp-write + rename.
  const filePath = credentialFilePath(publicOrigin, env);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
  return filePath;
}

export async function runImplicitLogin(
  options: ImplicitLoginOptions,
): Promise<ImplicitLoginResult> {
  type DeviceCode = { device_code: string; user_code: string; interval: number };
  const { data: issued } = await requestJson<DeviceCode>(options, "device code request", {
    path: "/api/auth/device/code",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: EVELAND_CLI_CLIENT_ID, scope: CLI_REQUESTED_SCOPE }),
  });

  const { response: signInResponse } = await requestJson<unknown>(options, "admin sign-in", {
    path: "/api/auth/sign-in/email",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: options.adminEmail, password: options.adminPassword }),
  });
  const cookie = signInResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) {
    throw new Error("Implicit CLI login failed: admin sign-in returned no session cookie.");
  }

  // The GET claims the code for the session; approve refuses unclaimed codes.
  await requestJson<unknown>(options, "device code claim", {
    path: `/api/auth/device?user_code=${encodeURIComponent(issued.user_code)}`,
    headers: { cookie },
  });
  await requestJson<unknown>(options, "device approval", {
    path: "/api/auth/device/approve",
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ userCode: issued.user_code }),
  });

  let intervalMs = Math.max(issued.interval, 1) * 1_000;
  for (let attempt = 0; attempt < MAX_TOKEN_POLLS; attempt += 1) {
    await options.sleep(intervalMs);
    const response = await options.fetchImpl(`${options.apiBaseUrl}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        origin: options.publicOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: issued.device_code,
        client_id: EVELAND_CLI_CLIENT_ID,
      }).toString(),
    });
    const text = await response.text();
    if (response.ok) {
      const token = JSON.parse(text) as {
        access_token: string;
        token_type: string;
        scope: string;
        expires_in?: number;
      };
      const obtainedAt = new Date();
      const scopes = token.scope.split(" ").filter(Boolean);
      const credentialPath = await writeCredential(options.publicOrigin, options.env, {
        accessToken: token.access_token,
        tokenType: token.token_type,
        scopes,
        obtainedAt: obtainedAt.toISOString(),
        expiresAt: token.expires_in
          ? new Date(obtainedAt.getTime() + token.expires_in * 1_000).toISOString()
          : null,
      });
      options.print(
        `CLI login ready: this machine's \`eveland\` is authenticated (${scopes.join(", ")}).`,
      );
      return { credentialPath, scopes, accessToken: token.access_token };
    }
    const error = (() => {
      try {
        return (JSON.parse(text) as { error?: string }).error;
      } catch {
        return undefined;
      }
    })();
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    throw new LoginStepError("token redemption", response.status, text);
  }
  throw new Error(
    "Implicit CLI login failed: the token endpoint never left authorization_pending.",
  );
}
