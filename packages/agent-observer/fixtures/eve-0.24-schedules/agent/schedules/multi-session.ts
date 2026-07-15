import { defineSchedule } from "eve/schedules";

import sink from "../channels/sink";

export default defineSchedule({
  cron: "45 6 * * *",
  async run({ appAuth, receive, waitUntil }) {
    waitUntil(
      Promise.all([
        receive(sink, {
          auth: appAuth,
          message: "Start fixture session one.",
          target: { continuationToken: "schedule-fixture-one" },
        }),
        receive(sink, {
          auth: appAuth,
          message: "Start fixture session two.",
          target: { continuationToken: "schedule-fixture-two" },
        }),
      ]),
    );
  },
});
