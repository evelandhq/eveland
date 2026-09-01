import { defineAgent } from "eve";

// Pin the model explicitly: the platform never overrides it, and eve's
// implicit default has moved between releases.
export default defineAgent({ model: "anthropic/claude-sonnet-5" });
