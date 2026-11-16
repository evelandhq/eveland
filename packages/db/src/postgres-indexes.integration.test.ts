import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { createDatabase } from "./client.js";
import { resolvePostgresTestUrl } from "./postgres-integration.test-support.js";

const databaseUrl = resolvePostgresTestUrl();
const database = databaseUrl ? createDatabase(databaseUrl) : null;

afterAll(async () => database?.close());

/**
 * The hot read paths depend on indexes that no unit test can observe: PGlite
 * runs the same migrations but the planner's choice only matters against real
 * Postgres. `enable_seqscan = off` is what makes these assertions meaningful on
 * a nearly-empty test table -- without it Postgres correctly prefers a
 * sequential scan and the plan would say nothing about whether the index
 * actually matches the query shape.
 */
describe.skipIf(!database)("hot-path index usage", () => {
  async function planFor(query: string): Promise<string> {
    const { db } = database!;
    await db.execute(sql.raw("set enable_seqscan = off"));
    try {
      const rows = await db.execute(sql.raw(`explain (costs off) ${query}`));
      return (rows as unknown as Array<Record<string, string>>)
        .map((row) => Object.values(row)[0] ?? "")
        .join("\n");
    } finally {
      await db.execute(sql.raw("set enable_seqscan = on"));
    }
  }

  test("the worker's job claim scan uses the queued partial index", async () => {
    const plan = await planFor(`
      select candidate.id
      from jobs candidate
      join projects project on project.id = candidate.project_id
      where candidate.status = 'queued'
      order by candidate.created_at asc, candidate.sequence asc
      limit 1
    `);

    expect(plan).toContain("jobs_queued_claim_idx");
  });

  test("the per-project mutual-exclusion probe uses the running partial index", async () => {
    const plan = await planFor(`
      select 1 from jobs running
      where running.project_id = 'proj_probe' and running.status = 'running'
    `);

    expect(plan).toContain("jobs_running_project_idx");
  });

  test("project job listings use the project/created index", async () => {
    const plan = await planFor(`
      select * from jobs where project_id = 'proj_probe'
      order by created_at desc limit 20
    `);

    expect(plan).toContain("jobs_project_created_idx");
  });

  test("durable Eve session identity resolves through a project-scoped index", async () => {
    const plan = await planFor(`
      select * from sessions
      where project_id = 'proj_probe' and eve_session_id = 'eve_probe' limit 1
    `);

    expect(plan).toContain("sessions_project_eve_session_idx");
  });

  test("session node listings use the root-session index", async () => {
    const plan = await planFor(`
      select * from session_nodes
      where root_session_id = 'sess_probe' order by created_at
    `);

    expect(plan).toContain("session_nodes_root_session_idx");
  });

  test("project log reads use the project/seq index for order and cursor anchoring", async () => {
    // Bitmap scans don't preserve index order, and on an empty test table the
    // planner may pick one over either seq index arbitrarily; forcing plain
    // index scans makes the assertion say what it means — this query shape is
    // served by this index in seq order, no Sort node required.
    const { db } = database!;
    await db.execute(sql.raw("set enable_bitmapscan = off"));
    try {
      // The bounded tail/cursor protocol orders and anchors on seq;
      // created_at ordering left the query surface with it (its index is
      // dropped in 0060).
      const orderedPlan = await planFor(`
      select * from logs where project_id = 'proj_probe' order by seq
    `);
      expect(orderedPlan).toContain("logs_project_seq_idx");
      expect(orderedPlan).not.toContain("Sort");

      const cursorPlan = await planFor(`
      select * from logs where project_id = 'proj_probe' and seq > 42 order by seq limit 500
    `);
      expect(cursorPlan).toContain("logs_project_seq_idx");

      // The CLI's default read is type-filtered; without the typed index a
      // sparse type walks arbitrarily many other-type rows to fill the
      // limit, so the API-side cap would not bound database work.
      const typedPlan = await planFor(`
      select * from logs
      where project_id = 'proj_probe' and type = 'runtime' and seq > 42
      order by seq limit 500
    `);
      expect(typedPlan).toContain("logs_project_type_seq_idx");
      expect(typedPlan).not.toContain("Sort");
    } finally {
      await db.execute(sql.raw("set enable_bitmapscan = on"));
    }
  });
});

describe.skipIf(!database)("concurrent Session event appends", () => {
  test("assign distinct indices under real concurrency", async () => {
    const { createPostgresStore } = await import("./postgres-store.js");
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `Event index integration ${Date.now()}`,
      importKind: "zip",
    });
    try {
      const revision = await store.recordSourceRevision({
        projectId: project.id,
        kind: "zip",
        sourcePath: "/tmp/event-index-integration",
        summary: {},
        envVars: [],
        files: [],
      });
      const deployment = await store.recordDeployment({
        projectId: project.id,
        sourceRevisionId: revision.id,
        imageTag: "event-index-integration",
        observerContract: 3,
        containerName: `event-index-integration-${Date.now()}`,
        internalPort: 3000,
        hostPort: 41994,
        runtimeKind: "docker",
      });
      const observe = (sourceSequence: number) =>
        store.ingestAgentEvent({
          telemetryEventId: `probe_${sourceSequence}`,
          eventFingerprint: `probe_${sourceSequence}`,
          deploymentId: deployment.id,
          eveSessionId: "eve_event_index",
          parentEveSessionId: null,
          sourceSequence,
          agent: { id: null, name: "root", nodeId: "root" },
          channelKind: "channel:eve",
          eventAt: new Date().toISOString(),
          event:
            sourceSequence === 0
              ? { type: "session.started", data: {} }
              : { type: "turn.started", scope: { turnId: `turn_${sourceSequence}` }, data: {} },
        });
      const { session } = await observe(0);

      // PGlite is single-connection and cannot express this race at all: the
      // pooled driver is the only place a count(*)-style index assignment
      // could be caught handing two appends the same index.
      await Promise.all(Array.from({ length: 12 }, (_, attempt) => observe(attempt + 1)));

      const indices = (await store.listSessionEvents(session.id)).map((event) => event.index);
      expect(indices).toEqual(Array.from({ length: 13 }, (_, i) => i));
    } finally {
      await store.deleteProject(project.id);
    }
  });
});
