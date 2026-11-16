import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Directory-form local child.",
  model: mockModel({ modelId: "dirchild-model", provider: "fixture", respond: () => "dir reply" }),
});
