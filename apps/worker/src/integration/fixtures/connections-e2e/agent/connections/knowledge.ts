import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "__EVELAND_CONNECTION_TEST_ORIGIN__/mcp/knowledge",
  description: "Authenticated MCP fixture for managed Connection verification.",
  auth: {
    getToken: async () => ({ token: process.env.CONNECTION_MCP_TOKEN! }),
  },
});
