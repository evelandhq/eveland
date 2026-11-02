import { defineSchedule } from "eve/schedules";

// v27 overlay (eve 0.91+ renamed the fire-and-forget prompt field from
// `markdown` to `content`); copied over the base fixture for v27 lines.
export default defineSchedule({
  cron: "15 4 * * 1-5",
  content: "Summarize the queued work.",
});
