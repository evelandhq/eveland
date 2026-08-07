import { defineChannel, POST } from "eve/channels";

export default defineChannel({
  routes: [POST("/noop", async () => new Response(null, { status: 204 }))],
  async receive(input, { from }) {
    return from(String(input.target.address)).send(input.message, {
      auth: input.auth,
    });
  },
});
