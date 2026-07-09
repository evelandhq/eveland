// Deliberately broken authored sandbox. eveland's sandbox injection
// (apps/worker/src/runtime/sandbox-inject.ts) unconditionally deletes every
// authored sandbox module and replaces it with a generated one before
// `eve build` ever compiles it. agent-sandbox-e2e.ts asserts this file is
// gone from the release and that the build log reports it as replaced -- if
// eveland ever regressed and let this reach a deployed agent, every sandbox
// command would fail immediately.
import { defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: () => {
    throw new Error("BROKEN AUTHORED SANDBOX: eveland must never let this reach a deployed agent.");
  },
});
