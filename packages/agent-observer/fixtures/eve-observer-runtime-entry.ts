import { readFile } from "node:fs/promises";
import { createObserverRuntime } from "../src/observer-runtime.ts";

// The observer runtime as src/hook-runtime.ts builds it, except that the
// policy comes from the path the real-eve test passes in the environment
// instead of the platform mount.
const runtime = createObserverRuntime({
  loadPolicy: async () =>
    JSON.parse(
      await readFile(process.env.EVELAND_OBSERVER_TEST_POLICY_PATH ?? "", "utf8"),
    ) as unknown,
});

export default runtime.hook;
export const observerHook = runtime.observerHook;
export const instrumentation = runtime.instrumentation;
