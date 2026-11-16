import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// A file-form subagent: eve gives it no hooks slot of its own.
export default defineAgent({
  description: "File-form local child.",
  model: mockModel({
    modelId: "filechild-model",
    provider: "fixture",
    respond: () => "file reply",
  }),
});
