import { defineChannel, POST } from "eve/channels";

// This fixture is compiled and executed by every Eve line in the compatibility
// matrix. Eve 0.29/0.30 handed the receive hook a `send` that addressed the
// session with a continuation token; Eve 0.31 hands it `from(address)`. Every
// line in the window is now 0.31+, so only the `from` branch runs; the
// structural cast is kept so the fixture still compiles unchanged if a future
// window ever spans two type generations again.
type ReceiveOps = {
  from?: (address: string) => {
    send(message: unknown, options: { auth: unknown }): Promise<{ id: string }>;
  };
  send?: (
    message: unknown,
    options: { auth: unknown; continuationToken: string },
  ) => Promise<{ id: string }>;
};

export default defineChannel({
  routes: [POST("/noop", async () => new Response(null, { status: 204 }))],
  async receive(input, ctx) {
    const address = String(input.target.address);
    const ops = ctx as unknown as ReceiveOps;
    if (ops.from) {
      return ops.from(address).send(input.message, { auth: input.auth });
    }
    if (!ops.send) throw new Error("Neither generation's channel operations are available.");
    return ops.send(input.message, { auth: input.auth, continuationToken: address });
  },
});
