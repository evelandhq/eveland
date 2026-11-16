import { mockModel } from "eve/evals";
import { defineInstrumentation } from "eve/instrumentation";

const root = mockModel({
  modelId: "served-root",
  provider: "fixture-gateway",
  respond: ({ toolResults }) =>
    toolResults.length === 0
      ? {
          toolCalls: [
            { name: "dirchild", input: { message: "hello directory child" } },
            { name: "probe__helper", input: { message: "hello extension child" } },
          ],
        }
      : "root done",
});

// Stands in for a gateway provider: eve resolves every string model id
// through `AI_SDK_DEFAULT_PROVIDER`.
export default defineInstrumentation({
  setup() {
    (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER = {
      specificationVersion: "v3",
      languageModel: () => root,
    };
  },
});
