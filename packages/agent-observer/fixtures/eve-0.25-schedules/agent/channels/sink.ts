import { defineChannel, POST } from "eve/channels";

export default defineChannel({
  routes: [POST("/noop", async () => new Response(null, { status: 204 }))],
  async receive(input, { send }) {
    return send(input.message, {
      auth: input.auth,
      continuationToken: String(input.target.continuationToken),
    });
  },
});
