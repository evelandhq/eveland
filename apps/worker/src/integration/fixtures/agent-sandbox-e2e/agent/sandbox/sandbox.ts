// Deliberately broken authored sandbox. eveland's sandbox injection
// (apps/worker/src/runtime/sandbox-inject.ts) removes this backend definition,
// preserves the sibling workspace seeds, and writes its generated backend
// module before `eve build` compiles the release. The integration smokes assert
// this file is gone, the seed remains, and the deployed session can read it.
import { defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: () => {
    throw new Error("BROKEN AUTHORED SANDBOX: eveland must never let this reach a deployed agent.");
  },
});
