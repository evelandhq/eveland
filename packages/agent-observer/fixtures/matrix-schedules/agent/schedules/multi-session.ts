import { defineSchedule } from "eve/schedules";

import sink from "../channels/sink";

// Runs under every Eve line in the compatibility matrix. Every line speaks
// fixed-session addressing: `to(channel, target).send(message, { auth })`.
export default defineSchedule({
  cron: "45 6 * * *",
  async run(ctx) {
    const { appAuth, waitUntil, to } = ctx;
    const start = (message: string, address: string) =>
      to(sink, { address }).send(message, { auth: appAuth });
    waitUntil(
      Promise.all([
        start("Start fixture session one.", "schedule-fixture-one"),
        start("Start fixture session two.", "schedule-fixture-two"),
      ]),
    );
  },
});
