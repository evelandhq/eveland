import { defineAgent } from "eve";

// The whole point of the Model Gateway: a bare gateway-style model string and
// nothing else — no provider import, no provider key. The platform-injected
// hook runtime resolves it through the Eveland Model Gateway at runtime.
//
// modelContextWindowTokens is explicit so `eve build` never consults the
// hard-coded Vercel model catalog (eve resolves context-window metadata there
// for string models unless the author declares it).
export default defineAgent({
  model: "zai/glm-5.3-flash",
  modelContextWindowTokens: 131_072,
});
