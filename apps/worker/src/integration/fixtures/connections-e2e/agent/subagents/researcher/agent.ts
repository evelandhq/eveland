import { defineAgent } from "eve";
import { connectionTestModel } from "../../connection-model.js";

export default defineAgent({
  model: connectionTestModel(),
  modelContextWindowTokens: 100_000,
  description: "Directory-form subagent used to verify a subagent-owned MCP Connection.",
});
