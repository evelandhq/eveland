import { readFile } from "node:fs/promises";
import { AGENT_RUNTIME_POLICY_PATH } from "@evelandhq/core/observability";
import { createObserverRuntime } from "./observer-runtime.js";

/**
 * Entry of the observer runtime bundle the Worker delivers into every
 * deployment's observability mount (and bakes into each release as the
 * fallback). A hook shim wraps the default export with `defineHook`, or
 * `observerHook(...)` when its agent has subagents that run without the hook;
 * the instrumentation shim wraps `instrumentation` with
 * `defineInstrumentation`. All import the same module URL, so they share one
 * process-wide runtime.
 */
const runtime = createObserverRuntime({
  loadPolicy: async () => JSON.parse(await readFile(AGENT_RUNTIME_POLICY_PATH, "utf8")) as unknown,
});

export default runtime.hook;
export const observerHook = runtime.observerHook;
export const instrumentation = runtime.instrumentation;
