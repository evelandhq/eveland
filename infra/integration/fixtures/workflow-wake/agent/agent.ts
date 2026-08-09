import { defineAgent } from "eve";
import { wakeTestModel } from "./wake-model";

export default defineAgent({
  model: wakeTestModel(),
  modelContextWindowTokens: 100_000,
});
