import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createOpenIdClientProtocol, type OidcTransaction } from "./oidc.js";
import type { OidcAuthorizationCodeConfig } from "./registry.js";

describe("openid-client OIDC protocol", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  let issuer = "";
  let expectedChallenge = "";
  let expectedNonce = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration") {
      response.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      }));
      return;
    }
    if (url.pathname === "/jwks") {
      response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key", use: "sig", alg: "RS256" }] }));
      return;
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(request));
      if (body.get("grant_type") === "authorization_code") {
        const verifier = body.get("code_verifier") ?? "";
        const challenge = await pkceChallenge(verifier);
        if (challenge !== expectedChallenge) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
      }
      response.end(JSON.stringify({
        access_token: body.get("grant_type") === "refresh_token" ? "refreshed-token" : "opaque-access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 300,
        ...(body.get("grant_type") === "refresh_token" ? {} : {
          id_token: jwt(privateKey, {
            iss: issuer,
            aud: "test-client",
            sub: "idp-user",
            nonce: expectedNonce,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
        }),
      }));
      return;
    }
    if (url.pathname === "/userinfo") {
      response.end(JSON.stringify({ sub: "idp-user" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });

  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock IdP did not bind a TCP port.");
    issuer = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  test("performs discovery, PKCE/state/nonce code exchange, refresh, and UserInfo", async () => {
    const protocol = createOpenIdClientProtocol({ allowInsecureIssuer: true });
    const config: OidcAuthorizationCodeConfig = {
      issuer,
      clientId: "test-client",
      scopes: ["openid", "offline_access"],
      audience: "https://agent.example",
      audienceMode: "both",
      tokenEndpointAuthMethod: "none",
      authorizationParams: { prompt: "consent" },
      accessTokenVerification: "userinfo",
    };
    const transaction: OidcTransaction = {
      state: "test-state",
      codeVerifier: "test-code-verifier-that-is-long-enough-for-pkce-0123456789",
      nonce: "test-nonce",
      redirectUri: "https://eveland.example/agent-auth/oidc/callback",
      agentConnectionId: "acon_test",
      securityRevision: 1,
      callerPrincipalId: "member-a",
      authMethod: "oidc",
      returnPath: "/projects/proj_test/playground",
    };
    await protocol.preflight(config);
    const authorization = await protocol.buildAuthorizationUrl(config, undefined, transaction);
    expectedChallenge = authorization.searchParams.get("code_challenge") ?? "";
    expectedNonce = authorization.searchParams.get("nonce") ?? "";
    expect(authorization.searchParams.get("state")).toBe(transaction.state);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe("https://agent.example");
    expect(authorization.searchParams.get("audience")).toBe("https://agent.example");

    const token = await protocol.exchangeAuthorizationCode(
      config,
      undefined,
      transaction,
      new URL(`${transaction.redirectUri}?code=test-code&state=${transaction.state}`),
    );
    expect(token).toMatchObject({ accessToken: "opaque-access-token", refreshToken: "refresh-token", subject: "idp-user" });
    await expect(protocol.fetchUserInfo(config, undefined, token.accessToken, token.subject)).resolves.toEqual({ subject: "idp-user" });
    await expect(protocol.refresh(config, undefined, token.refreshToken!, token.subject)).resolves.toMatchObject({
      accessToken: "refreshed-token",
      subject: "idp-user",
    });
  });
});

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function pkceChallenge(verifier: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
}

function jwt(key: import("node:crypto").KeyObject, payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${claims}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}
