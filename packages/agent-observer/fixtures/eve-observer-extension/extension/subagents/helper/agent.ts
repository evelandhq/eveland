import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// Annotated so `eve extension build` can emit a declaration without naming
// the AI SDK provider types the mock model carries.
const helper: ReturnType<typeof defineAgent> = defineAgent({
  description: "Extension directory-form helper.",
  model: mockModel({
    modelId: "ext-helper-model",
    provider: "fixture",
    respond: () => "ext reply",
  }),
});

export default helper;
