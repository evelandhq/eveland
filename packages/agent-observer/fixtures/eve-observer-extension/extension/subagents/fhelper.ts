import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// A file-form Extension subagent: like a local one, eve gives it no hooks
// slot of its own.
const fhelper: ReturnType<typeof defineAgent> = defineAgent({
  description: "Extension file-form helper.",
  model: mockModel({
    modelId: "ext-fhelper-model",
    provider: "fixture",
    respond: () => "ext file reply",
  }),
});

export default fhelper;
