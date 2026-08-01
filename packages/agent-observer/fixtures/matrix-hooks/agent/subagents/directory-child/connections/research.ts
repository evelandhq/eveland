import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "http://127.0.0.1:43902/mcp",
  description: "Research connection compatibility fixture.",
  auth: {
    getToken: async () => ({ token: process.env.RESEARCH_TOKEN! }),
  },
});
