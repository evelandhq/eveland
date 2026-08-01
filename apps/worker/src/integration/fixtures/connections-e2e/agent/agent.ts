import { defineAgent } from "eve";
import { connectionTestModel } from "./connection-model.js";

export default defineAgent({
  model: connectionTestModel(),
  modelContextWindowTokens: 100_000,
});
