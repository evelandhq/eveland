import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  defineOpenAPIConnection,
} from "eve/connections";

const origin = "__EVELAND_CONNECTION_TEST_ORIGIN__";

// The token each user's completed sign-in issued. Process memory is enough:
// the smoke signs in and calls on one running Deployment.
const tokens = new Map<string, string>();

function userOf(principal: { type: string; id?: string }): string {
  return principal.type === "user" && principal.id ? principal.id : "app";
}

// Self-hosted interactive OAuth. eve mints the callback URL the provider
// redirects back to; the smoke reads it from the authorize URL below and
// completes the sign-in through the Agent Gateway.
export default defineOpenAPIConnection({
  spec: {
    openapi: "3.1.0",
    info: { title: "Eveland sign-in Connection fixture", version: "1.0.0" },
    paths: {
      "/signin-status": {
        get: {
          operationId: "getSigninStatus",
          summary: "Get the signed-in connection status",
          responses: {
            "200": {
              description: "Signed-in status",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { type: "string" } },
                    required: ["status"],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  baseUrl: `${origin}/openapi`,
  description: "OAuth-protected OpenAPI fixture for the self-hosted sign-in proof.",
  auth: defineInteractiveAuthorization({
    getToken: async ({ principal }) => {
      const token = tokens.get(userOf(principal));
      if (!token) throw new ConnectionAuthorizationRequiredError("signin");
      return { token };
    },
    startAuthorization: async ({ callbackUrl }) => ({
      challenge: {
        url: `${origin}/oauth/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`,
      },
    }),
    completeAuthorization: async ({ principal, callback }) => {
      const token = `signin-${String(callback.params.code)}`;
      tokens.set(userOf(principal), token);
      return { token };
    },
  }),
});
