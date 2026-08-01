import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "30 5 * * *",
  async run({ waitUntil }) {
    waitUntil(Promise.resolve());
  },
});
