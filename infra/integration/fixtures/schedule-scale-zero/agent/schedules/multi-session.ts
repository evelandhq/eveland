import { defineSchedule } from "eve/schedules";
import sink from "../channels/sink";

export default defineSchedule({
  cron: "* * * * *",
  async run({ appAuth, receive, waitUntil }) {
    waitUntil(
      Promise.all([
        receive(sink, {
          auth: appAuth,
          message: "Run scheduled fixture session one.",
          target: { continuationToken: "scale-zero-one" },
        }),
        receive(sink, {
          auth: appAuth,
          message: "Run scheduled fixture session two.",
          target: { continuationToken: "scale-zero-two" },
        }),
      ]),
    );
  },
});
