import { defineChannel, POST } from "eve/channels";

// A custom channel for the routing proof in infra/integration/gateway-e2e.mts:
// each message to a thread answers with its session and the Deployment that
// handled the route. The fixture's hook reports where each turn ran.
export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { from, params }) => {
      const body = (await request.json()) as { message: string };
      const delivery = await from(params.threadId).send(body.message, { auth: null });
      return Response.json(
        { sessionId: delivery.sessionId, handledBy: process.env.EVELAND_DEPLOYMENT_ID },
        { status: 202 },
      );
    }),
  ],
});
