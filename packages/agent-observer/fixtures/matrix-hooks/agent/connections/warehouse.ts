import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "http://127.0.0.1:43901/mcp",
  description: "Warehouse connection compatibility fixture.",
  auth: {
    getToken: async () => ({ token: process.env.WAREHOUSE_TOKEN! }),
  },
});
