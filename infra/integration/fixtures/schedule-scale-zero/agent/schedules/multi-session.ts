import { defineSchedule } from "eve/schedules";
import sink from "../channels/sink";

export default defineSchedule({
  cron: "* * * * *",
  async run({ appAuth, to, waitUntil }) {
    waitUntil(
      Promise.all([
        to(sink, { address: "scale-zero-one" }).send("Run scheduled fixture session one.", {
          auth: appAuth,
        }),
        to(sink, { address: "scale-zero-two" }).send("Run scheduled fixture session two.", {
          auth: appAuth,
        }),
      ]),
    );
  },
});
