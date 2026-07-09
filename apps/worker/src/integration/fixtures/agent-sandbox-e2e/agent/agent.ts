import { defineAgent } from "eve";

// Real model id string so `eve build` compiles a real agent. No credential is
// needed at build time, and the deployed unit sets EVE_MOCK_AUTHORED_MODELS=1
// (see agent-sandbox-e2e.ts) so a turn never reaches a real model provider.
export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
