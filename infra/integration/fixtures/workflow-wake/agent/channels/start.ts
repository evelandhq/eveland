import { defineChannel, POST } from "eve/channels";

/**
 * Starts Eve's real durable turn workflow with a deterministic model that calls
 * the opt-in durable sleep tool once.
 */
export default defineChannel({
  routes: [
    POST("/start-wake", async (request, { from }) => {
      const input = (await request.json()) as { seconds?: unknown; token?: unknown };
      if (
        typeof input.seconds !== "number" ||
        !Number.isSafeInteger(input.seconds) ||
        input.seconds <= 0 ||
        typeof input.token !== "string" ||
        input.token.length === 0
      ) {
        return Response.json(
          { error: "positive integer seconds and token are required" },
          { status: 400 },
        );
      }
      const session = await from(input.token).send(`sleep-seconds:${String(input.seconds)}`, {
        auth: null,
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
  async receive(input, { send }) {
    return send(input.message, { auth: input.auth });
  },
});
