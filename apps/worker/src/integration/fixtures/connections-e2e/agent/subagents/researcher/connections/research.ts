import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "__EVELAND_CONNECTION_TEST_ORIGIN__/mcp/research",
  description: "Authenticated MCP fixture owned by the researcher subagent.",
  auth: {
    getToken: async () => ({ token: process.env.CONNECTION_MCP_TOKEN! }),
  },
});
