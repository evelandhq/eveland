import { defineChannel, POST } from "eve/channels";

// This fixture is compiled and executed by every Eve line in the compatibility
// matrix. Every line speaks fixed-session addressing: the receive hook starts
// the session through `from(address)`.
export default defineChannel({
  routes: [POST("/noop", async () => new Response(null, { status: 204 }))],
  async receive(input, ctx) {
    const address = String(input.target.address);
    return ctx.from(address).send(input.message, { auth: input.auth });
  },
});
