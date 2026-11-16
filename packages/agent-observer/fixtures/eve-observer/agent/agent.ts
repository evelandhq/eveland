import { defineAgent } from "eve";

// A string model id, resolved by the default provider that
// instrumentation/provider.ts installs: the provider serves a model whose own
// id differs from the reference eve selects, as a gateway can.
export default defineAgent({
  model: "fixture/root-requested",
  modelContextWindowTokens: 100_000,
});
