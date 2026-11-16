import { defineAgent } from "eve";

// An Extension directory-form subagent: the worker writes the observer hook
// into the installed package.
export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  description: "Extension directory-form subagent used for observer lineage proof.",
});
