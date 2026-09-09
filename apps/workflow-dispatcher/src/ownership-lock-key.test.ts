import { WORKFLOW_DISPATCHER_OWNERSHIP_LOCK_KEY } from "@evelandhq/core/workflow-dispatch";
import { DISPATCHER_OWNERSHIP_LOCK_KEY } from "@evelandhq/workflow-world/dispatcher";
import { expect, test } from "vitest";

test("the ctl names the same ownership lock the dispatcher takes", () => {
  // `eveland-ctl dispatcher-lock` reads and terminates the holder of this key
  // without depending on the package, so the mirror in core must track it.
  expect(WORKFLOW_DISPATCHER_OWNERSHIP_LOCK_KEY).toBe(DISPATCHER_OWNERSHIP_LOCK_KEY);
});
