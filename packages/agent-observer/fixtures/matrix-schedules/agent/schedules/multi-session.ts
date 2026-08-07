import { defineSchedule } from "eve/schedules";

import sink from "../channels/sink";

// Runs under every Eve line in the compatibility matrix. Eve 0.29/0.30 pass
// `receive(channel, { auth, message, target })`; Eve 0.31 passes
// `to(channel, target).send(message, { auth })`. The structural cast keeps one
// source compiling under both type generations.
type ScheduleOps = {
  receive?: (
    channel: typeof sink,
    input: { auth: unknown; message: string; target: Record<string, unknown> },
  ) => Promise<unknown>;
  to?: (
    channel: typeof sink,
    target: Record<string, unknown>,
  ) => { send(message: string, options: { auth: unknown }): Promise<unknown> };
};

export default defineSchedule({
  cron: "45 6 * * *",
  async run(ctx) {
    const { appAuth, waitUntil } = ctx;
    const ops = ctx as unknown as ScheduleOps;
    const start = (message: string, address: string) => {
      if (ops.to) return ops.to(sink, { address }).send(message, { auth: appAuth });
      if (!ops.receive) throw new Error("Neither generation's schedule operations are available.");
      return ops.receive(sink, { auth: appAuth, message, target: { address } });
    };
    waitUntil(
      Promise.all([
        start("Start fixture session one.", "schedule-fixture-one"),
        start("Start fixture session two.", "schedule-fixture-two"),
      ]),
    );
  },
});
