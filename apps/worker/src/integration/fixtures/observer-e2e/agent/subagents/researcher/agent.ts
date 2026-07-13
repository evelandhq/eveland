import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  description: "Researcher subagent used for observer parent-child integration proof.",
});
