import { describe, expect, test } from "vitest";
import { createTestStore } from "@eveland/db/vitest";
import { createApp } from "./app.js";
import { createScheduleRunFixture } from "./app.test-support.js";

// Runtime-internal capability and infrastructure fields must never reach the
// browser. Key-name assertions are the durable ratchet; value assertions
// catch a leak that survives a field rename.
const FORBIDDEN_KEYS = [
  '"continuationToken"',
  '"containerName"',
  '"internalPort"',
  '"imageTag"',
  '"observerContract"',
];
const CONTINUATION_TOKEN = "forbidden-continuation-token-value";
const HOST_SOURCE_PATH = "/tmp/scheduled-agent";

async function serializedBody(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  return JSON.stringify(await response.json());
}

describe("control-plane responses redact internal fields", () => {
  test("session, usage, schedule-run, revision, deployment, and project routes", async () => {
    const store = createTestStore();
    const { project, deployment, run } = await createScheduleRunFixture(store);
    const session = await store.createSession({
      projectId: project.id,
      deploymentId: deployment.id,
      trigger: "playground",
      eveSessionId: "eve-session-redaction",
      continuationToken: CONTINUATION_TOKEN,
    });
    const app = createApp(store);

    const bodies = Object.entries({
      session: await serializedBody(await app.request(`/sessions/${session.id}`)),
      sessions: await serializedBody(await app.request(`/projects/${project.id}/sessions`)),
      usage: await serializedBody(await app.request("/usage")),
      projectUsage: await serializedBody(await app.request(`/projects/${project.id}/usage`)),
      scheduleRuns: await serializedBody(
        await app.request(`/projects/${project.id}/schedule-runs`),
      ),
      scheduleRunDetail: await serializedBody(await app.request(`/schedule-runs/${run.id}`)),
      sourceRevision: await serializedBody(
        await app.request(`/projects/${project.id}/source/revision`),
      ),
      deployments: await serializedBody(await app.request(`/projects/${project.id}/deployments`)),
      projects: await serializedBody(await app.request("/projects")),
      schedules: await serializedBody(await app.request(`/projects/${project.id}/schedules`)),
    });
    for (const [route, body] of bodies) {
      for (const key of FORBIDDEN_KEYS) {
        expect.soft(body, `${route} must not serialize ${key}`).not.toContain(key);
      }
      expect
        .soft(body, `${route} must not leak the continuation token`)
        .not.toContain(CONTINUATION_TOKEN);
      expect
        .soft(body, `${route} must not leak the host source path`)
        .not.toContain(HOST_SOURCE_PATH);
    }
  });

  test("the source revision keeps its metadata but drops the host path field entirely", async () => {
    const store = createTestStore();
    const { project } = await createScheduleRunFixture(store, false);
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}/source/revision`);
    expect(response.status).toBe(200);
    const { revision } = (await response.json()) as { revision: Record<string, unknown> };
    expect(revision).toMatchObject({ projectId: project.id, kind: "zip" });
    expect(revision).not.toHaveProperty("sourcePath");
  });

  test("schedule summaries keep the repo-relative version source path the UI shows", async () => {
    const store = createTestStore();
    const { project } = await createScheduleRunFixture(store, false);
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}/schedules`);
    expect(response.status).toBe(200);
    const { schedules } = (await response.json()) as {
      schedules: Array<{ version: { sourcePath: string } | null }>;
    };
    expect(schedules[0]?.version?.sourcePath).toBe("agent/schedules/billing/sweep.ts");
  });

  test("the deployments overview keeps the host port the deployments page displays", async () => {
    const store = createTestStore();
    const { project } = await createScheduleRunFixture(store, false);
    const app = createApp(store);

    const response = await app.request(`/projects/${project.id}/deployments`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deployments: Array<{ hostPort: number }> };
    expect(body.deployments[0]?.hostPort).toBe(41993);
  });
});
