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
      const session = await store.createSession({
        projectId: project.id,
        trigger: "playground",
      });

      // PGlite is single-connection and cannot express this race at all: the
      // pooled driver is the only place the old count(*) assignment could be
      // caught handing two appends the same index.
      const appends = await Promise.all(
        Array.from({ length: 12 }, (_, attempt) =>
          store.appendSessionEvent(session.id, "platform.probe", { attempt }),
        ),
      );

      const indices = appends.map((event) => event.index).sort((a, b) => a - b);
      expect(new Set(indices).size).toBe(appends.length);
      expect(indices).toEqual(Array.from({ length: appends.length }, (_, i) => i));
    } finally {
      await store.deleteProject(project.id);
    }
  });
});

describe.skipIf(!database)("concurrent log appends", () => {
  test("appendLog serializes per project so seq is commit-ordered — a cursor never skips", async () => {
    const { createPostgresStore } = await import("./postgres-store.js");
    const { projects } = await import("./schema.js");
    const { eq } = await import("drizzle-orm");
    const { setTimeout: delay } = await import("node:timers/promises");
    const store = createPostgresStore(database!);
    const project = await store.createProject({
      name: `Log append integration ${Date.now()}`,
      importKind: "zip",
    });
    try {
      // The race the FOR UPDATE closes: a transaction could allocate a lower
      // seq but commit after a higher one, leaving a follower's `seq >
      // cursor` permanently blind to it. Hold the project lock in an open
      // transaction and prove a concurrent appendLog cannot even allocate
      // until it commits.
      let holderDone = false;
      const holder = database!.db.transaction(async (tx) => {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, project.id))
          .for("update");
        await delay(400);
        holderDone = true;
      });
      await delay(100);
      const blocked = store.appendLog({ projectId: project.id, type: "runtime", line: "waited" });
      const outcome = await Promise.race([
        blocked.then(() => "appended" as const),
        delay(150).then(() => "still-blocked" as const),
      ]);
      expect(outcome).toBe("still-blocked");
      await holder;
      await blocked;
      expect(holderDone).toBe(true);

      // Under a real pooled hammer, cursor paging must recover every line
      // with strictly increasing positions and no gaps against the full set.
      const written = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          store.appendLog({ projectId: project.id, type: "build", line: `hammer ${index}` }),
        ),
      );
      const collected: string[] = [];
      let cursor = "0";
      for (;;) {
        const page = await store.listLogsPage(project.id, "build", { limit: 7, after: cursor });
        collected.push(...page.logs.map((log) => log.line));
        if (page.logs.length < 7) break;
        cursor = page.cursor;
      }
      expect(collected.sort()).toEqual(written.map((log) => log.line).sort());
    } finally {
      await store.deleteProject(project.id);
    }
  });
});
