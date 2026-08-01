import { defineOpenAPIConnection } from "eve/connections";

const origin = "__EVELAND_CONNECTION_TEST_ORIGIN__";

export default defineOpenAPIConnection({
  spec: {
    openapi: "3.1.0",
    info: { title: "Eveland managed Connection fixture", version: "1.0.0" },
    paths: {
      "/status": {
        get: {
          operationId: "getConnectionStatus",
          summary: "Get the managed connection status",
          responses: {
            "200": {
              description: "Connection status",
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
  description: "Authenticated OpenAPI fixture for managed Connection verification.",
  auth: {
    getToken: async () => ({ token: process.env.CONNECTION_OPENAPI_TOKEN! }),
  },
});
