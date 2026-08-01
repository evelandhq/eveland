import { unsupportedEveVersionMessage } from "@eveland/core/source";
import type { Store } from "@eveland/db";

import { playgroundMessageSchema } from "./app-schemas.js";
import {
  resolveProjectEveVersion,
  type EveVersionStore,
} from "./app-support.js";
import type { ApiApp } from "./app-types.js";
import type {
  PlaygroundRunEvent,
  PlaygroundRunner,
} from "./gateway-playground.js";

type LegacyPlaygroundStore = EveVersionStore &
  Pick<
    Store,
    | "appendSessionEvent"
    | "completeSession"
    | "createSession"
    | "getProject"
    | "listSessionEvents"
  >;

// Compatibility adapter for the pre-canonical JSON Playground endpoint.
// Current Web clients use /playground/eve/*; keep the old protocol isolated
// so it can be removed without reopening the canonical streaming path.
export function registerLegacyPlaygroundRoute(input: {
  app: ApiApp;
  store: LegacyPlaygroundStore;
  playgroundRunner: PlaygroundRunner;
}): void {
  const { app, store, playgroundRunner } = input;

  app.post("/projects/:projectId/playground", async (context) => {
    const projectId = context.req.param("projectId");
    const parsed = playgroundMessageSchema.safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json(
        { error: "Invalid playground message", issues: parsed.error.issues },
        400,
      );
    }

    const project = await store.getProject(projectId);
    if (!project) {
      return context.json({ error: "Project not found" }, 404);
    }
    const deployment = await store.getCurrentDeployment(projectId);
    if (
      !deployment ||
      (deployment.status !== "running" && deployment.status !== "stopped")
    ) {
      return context.json({ error: "No running deployment" }, 409);
    }
    const eveVersion = await resolveProjectEveVersion(
      store,
      projectId,
      deployment.id,
    );
    if (!eveVersion.supported) {
      return context.json(
        {
          error: "Unsupported Eve version",
          detail: unsupportedEveVersionMessage(eveVersion.version),
          eveVersion,
        },
        409,
      );
    }

    const session = await store.createSession({
      projectId,
      deploymentId: deployment.id,
      trigger: "playground",
      scheduleId: null,
    });
    await store.appendSessionEvent(session.id, "message", {
      role: "user",
      content: parsed.data.message,
    });

    try {
      let eventPersistence = Promise.resolve();
      const persistEvent = (event: PlaygroundRunEvent) => {
        const queued = eventPersistence.then(async () => {
          await store.appendSessionEvent(session.id, event.type, event.payload);
        });
        eventPersistence = queued.catch(() => undefined);
        return queued;
      };
      const result = await playgroundRunner({
        project,
        deployment,
        message: parsed.data.message,
        onEvent: persistEvent,
      });
      for (const event of
        result.events ?? [
          { type: "model_response", payload: { content: result.response } },
        ]) {
        await persistEvent(event);
      }
      const completed = await store.completeSession(session.id, {
        status: result.status ?? "waiting",
        eveSessionId: result.eveSessionId ?? null,
        continuationToken: result.continuationToken ?? null,
      });
      return context.json(
        {
          session: completed,
          events: await store.listSessionEvents(session.id),
        },
        201,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.appendSessionEvent(session.id, "error", { message });
      const failed = await store.completeSession(session.id, {
        status: "failed",
      });
      return context.json(
        {
          error: "Playground request failed",
          detail: message,
          session: failed,
          events: await store.listSessionEvents(session.id),
        },
        502,
      );
    }
  });
}
