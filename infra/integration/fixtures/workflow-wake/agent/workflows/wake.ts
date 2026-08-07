/**
 * A durable workflow whose only job is to exist under a known name, so the
 * platform can schedule a message for it and prove the Agent is woken to
 * receive it.
 *
 * `"use workflow"` is eve's marker: the build transforms the function into a
 * durable run and registers a queue for it. Without a registered workflow the
 * Agent answers "Unhandled queue" — correctly — and the dispatch cannot show
 * anything about resumption.
 */
export async function wake(): Promise<string> {
  "use workflow";
  return await recordWake();
}

async function recordWake(): Promise<string> {
  "use step";
  return "awake";
}
