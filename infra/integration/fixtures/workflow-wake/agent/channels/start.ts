import { defineChannel, POST } from "eve/channels";
import { wake } from "../workflows/wake";

/**
 * Reaches the workflow from the Agent graph so the build discovers it, and
 * gives the test a way to start a run over HTTP.
 */
export default defineChannel({
  routes: [
    POST("/start-wake", async () => {
      const run = await wake();
      return Response.json({ started: run });
    }),
  ],
  async receive(input, { send }) {
    return send(input.message, { auth: input.auth });
  },
});
