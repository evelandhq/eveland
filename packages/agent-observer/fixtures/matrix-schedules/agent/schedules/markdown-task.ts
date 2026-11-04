import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "15 4 * * 1-5",
  content: "Summarize the queued work.",
});
