import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "15 4 * * 1-5",
  markdown: "Summarize the queued work.",
});
