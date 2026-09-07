import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { FetchLike } from "./api-client.ts";
import { projectSlugFrom, runDeploy } from "./deploy.ts";

async function makeProject(eve = "0.50.0", name = "tour-guide"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eveland-deploy-src-"));
  await mkdir(path.join(root, "agent"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name, dependencies: { eve } }));
  await writeFile(path.join(root, "agent", "instructions.md"), "Be helpful.");
  return root;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FakeJob = {
  id: string;
  type: string;
  status: string;
  lastError: string | null;
  parentJobId?: string | null;
  deploymentId?: string | null;
};

/**
 * A scripted platform: fixed instance window, a mutable project/job/log
 * state the test advances between polls. It serves no deployment list and
 * no promote route: the CLI must learn the deployment from its own build job
 * and leave promotion to the server-side job.
 */
function fakePlatform(options: {
  projects?: Array<{ id: string; slug: string; importKind: string }>;
  preexistingJobs?: FakeJob[];
  jobTimeline?: FakeJob[][];
  logTimeline?: string[][];
  preflightOutcome?: { status: string; error: string | null };
}) {
  const calls: Array<{
    method: string;
    url: string;
    form: FormData | null;
    jsonBody: unknown;
  }> = [];
  let polls = 0;
  // The baseline logs snapshot happens before the upload; new activity only
  // appears once the deploy has been submitted.
  let submitted = false;
  const jobTimeline = options.jobTimeline ?? [];
  const logTimeline = options.logTimeline ?? [];
  let logId = 0;
  const emittedLogs: Array<{ id: string; line: string }> = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const form = init?.body instanceof FormData ? init.body : null;
    const jsonBody = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, url, form, jsonBody });
    const { pathname, searchParams } = new URL(url);

    if (pathname === "/api/instance") {
      return json(200, {
        eve: {
          supportedRanges: ["0.50.x", "0.51.x", "0.52.x"],
          expected: "0.50.x, 0.51.x, or 0.52.x",
        },
      });
    }
    if (pathname === "/api/projects" && method === "GET") {
      return json(200, { projects: options.projects ?? [] });
    }
    if (pathname === "/api/source-preflights" && method === "POST") {
      return json(202, { preflight: { id: "pre_1", status: "queued" } });
    }
    if (pathname.startsWith("/api/source-preflights/")) {
      return json(200, {
        preflight: options.preflightOutcome ?? { status: "completed", error: null },
      });
    }
    if (pathname === "/api/projects" && method === "POST") {
      submitted = true;
      return json(201, { project: { id: "proj_new" } });
    }
    if (pathname.endsWith("/sync-source")) {
      submitted = true;
      return json(202, { job: { id: "job_i", type: "import_source", status: "queued" } });
    }
    if (pathname.endsWith("/jobs")) {
      expect(searchParams.get("include")).toBe("deployment");
      if (!submitted) return json(200, { jobs: options.preexistingJobs ?? [] });
      const step = Math.min(polls, jobTimeline.length - 1);
      const timeline = jobTimeline[step] ?? [];
      return json(200, { jobs: [...timeline, ...(options.preexistingJobs ?? [])] });
    }
    if (pathname.endsWith("/logs")) {
      // Bounded reads only: the client must always send limit or after, and
      // every response carries a usable cursor (position in insertion order).
      expect(searchParams.get("limit") ?? searchParams.get("after")).not.toBeNull();
      const respond = () => {
        const after = searchParams.get("after");
        const limit = Number(searchParams.get("limit") ?? emittedLogs.length);
        const slice = after !== null ? emittedLogs.slice(Number(after)) : emittedLogs.slice(-limit);
        const page = slice.slice(0, limit);
        const cursor =
          page.length > 0
            ? String(emittedLogs.indexOf(page.at(-1)!) + 1)
            : (after ?? String(emittedLogs.length));
        return json(200, { logs: page, cursor });
      };
      if (!submitted) return respond();
      const step = Math.min(polls, logTimeline.length - 1);
      for (const line of logTimeline[step] ?? []) {
        if (!emittedLogs.some((log) => log.line === line)) {
          logId += 1;
          emittedLogs.push({ id: `log_${logId}`, line });
        }
      }
      polls += 1;
      return respond();
    }
    if (pathname.endsWith("/endpoints")) {
      return json(200, {
        stable: "http://tour-guide.agent.localhost:17300",
        previews: ["http://abc123--tour-guide.agent.localhost:17300"],
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function io(
  platform: ReturnType<typeof fakePlatform>,
  provenance: { baseCommitSha: string; dirty: boolean } | null = null,
) {
  const printed: string[] = [];
  return {
    printed,
    io: {
      fetchImpl: platform.fetchImpl,
      print: (line: string) => printed.push(line),
      sleep: async () => {},
      detectProvenance: async () => provenance,
    },
  };
}

const IMPORT_DONE: FakeJob = {
  id: "job_i",
  type: "import_source",
  status: "completed",
  lastError: null,
  parentJobId: null,
  deploymentId: null,
};
const OUR_BUILD = (status: string, deploymentId: string | null = null): FakeJob => ({
  id: "job_b",
  type: "build_deploy",
  status,
  lastError: null,
  parentJobId: "job_i",
  deploymentId,
});

// Newest first, like the platform's job list.
const BUILD_DONE: FakeJob[][] = [
  [IMPORT_DONE],
  [OUR_BUILD("running"), IMPORT_DONE],
  [OUR_BUILD("completed", "dep_new"), IMPORT_DONE],
];

const PROMOTED_LINE = "Promoted: routes and the schedule target now point at this deployment.";

describe("eveland deploy", () => {
  test("creates a fresh project with promotion requested up front and streams build logs", async () => {
    const platform = fakePlatform({
      jobTimeline: BUILD_DONE,
      logTimeline: [["importing source"], ["importing source", "eve build ok"], []],
    });
    const { io: deployIo, printed } = io(platform);

    const result = await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      promote: true,
      io: deployIo,
    });

    expect(result).toMatchObject({
      slug: "tour-guide",
      projectId: "proj_new",
      deploymentId: "dep_new",
      promoted: true,
      stableUrl: "http://tour-guide.agent.localhost:17300",
    });
    // Preflight-first: the archive goes to the preflight endpoint, and the
    // project is created from the validated preflight id.
    const preflight = platform.calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/source-preflights"),
    );
    const archiveEntry = preflight?.form?.get("archive");
    expect(archiveEntry).toBeInstanceOf(File);
    expect((archiveEntry as File).size).toBeGreaterThan(0);
    const create = platform.calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/projects"),
    );
    expect(create?.form).toBeNull();
    // Promote rides on the create request so the worker promotes inside the
    // build job; the CLI never promotes from the client side. Not a checkout:
    // no provenance is claimed, and the output says so.
    expect(create?.jsonBody).toEqual({
      name: "tour-guide",
      preflightId: "pre_1",
      deployAfterImport: true,
      promoteAfterDeploy: true,
    });
    expect(platform.calls.some((call) => call.url.includes("/promote"))).toBe(false);
    expect(platform.calls.some((call) => call.url.endsWith("/deployments"))).toBe(false);
    const output = printed.join("\n");
    expect(output).toContain("importing source");
    expect(output).toContain("eve build ok");
    expect(output).toContain("Source: not a git checkout");
    expect(printed).toContain(PROMOTED_LINE);
    // Each log line prints once despite polling the cumulative history.
    expect(printed.filter((line) => line.includes("importing source"))).toHaveLength(1);
  });

  test("redeploys an existing zip project through sync-source with promote in the request", async () => {
    const platform = fakePlatform({
      projects: [{ id: "proj_1", slug: "tour-guide", importKind: "zip" }],
      preexistingJobs: [
        {
          id: "job_old",
          type: "build_deploy",
          status: "failed",
          lastError: "old failure",
          parentJobId: null,
          deploymentId: null,
        },
      ],
      jobTimeline: BUILD_DONE,
      logTimeline: [["fresh build line"]],
    });
    const { io: deployIo, printed } = io(platform);

    const result = await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      promote: true,
      io: deployIo,
    });

    expect(result).toMatchObject({
      projectId: "proj_1",
      importKind: "zip",
      deploymentId: "dep_new",
      promoted: true,
      provenance: null,
    });
    const sync = platform.calls.find((call) => call.url.includes("/sync-source"));
    expect(sync?.form?.get("deploy")).toBe("true");
    expect(sync?.form?.get("promote")).toBe("true");
    expect(sync?.form?.get("baseCommitSha")).toBeNull();
    expect(sync?.form?.get("dirty")).toBeNull();
    expect(platform.calls.some((call) => call.url.includes("/promote"))).toBe(false);
    expect(printed.join("\n")).toContain("fresh build line");
    expect(printed).toContain(PROMOTED_LINE);
  });

  test("sends the base commit and dirty state it detected, on redeploys and first deploys", async () => {
    const provenance = { baseCommitSha: "f".repeat(40), dirty: true };
    const redeploy = fakePlatform({
      projects: [{ id: "proj_1", slug: "tour-guide", importKind: "zip" }],
      jobTimeline: BUILD_DONE,
      logTimeline: [[]],
    });
    const { io: redeployIo, printed } = io(redeploy, provenance);
    // No promote flag either way: a zip project promotes by default.
    const result = await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      io: redeployIo,
    });
    expect(result).toMatchObject({ promoted: true, provenance });
    const sync = redeploy.calls.find((call) => call.url.includes("/sync-source"));
    expect(sync?.form?.get("promote")).toBe("true");
    expect(sync?.form?.get("baseCommitSha")).toBe("f".repeat(40));
    expect(sync?.form?.get("dirty")).toBe("true");
    expect(printed.join("\n")).toContain(
      "Source: based on commit ffffffffffff (with uncommitted changes).",
    );

    const fresh = fakePlatform({ jobTimeline: BUILD_DONE, logTimeline: [[]] });
    await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      io: io(fresh, { baseCommitSha: "e".repeat(40), dirty: false }).io,
    });
    const create = fresh.calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/projects"),
    );
    expect(create?.jsonBody).toEqual({
      name: "tour-guide",
      preflightId: "pre_1",
      deployAfterImport: true,
      promoteAfterDeploy: true,
      baseCommitSha: "e".repeat(40),
      dirty: false,
    });
  });

  test("uploads to a git project as a preview by default, or as a hotfix with --promote", async () => {
    const preview = fakePlatform({
      projects: [{ id: "proj_1", slug: "tour-guide", importKind: "git" }],
      jobTimeline: BUILD_DONE,
      logTimeline: [[]],
    });
    const { io: previewIo, printed } = io(preview, { baseCommitSha: "d".repeat(40), dirty: false });
    const result = await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      io: previewIo,
    });
    expect(result).toMatchObject({ importKind: "git", promoted: false, deploymentId: "dep_new" });
    const sync = preview.calls.find((call) => call.url.includes("/sync-source"));
    expect(sync?.form?.get("deploy")).toBe("true");
    expect(sync?.form?.get("promote")).toBeNull();
    expect(sync?.form?.get("baseCommitSha")).toBe("d".repeat(40));
    expect(printed).not.toContain(PROMOTED_LINE);
    expect(printed.join("\n")).toContain(
      "Deployed as a preview: 'tour-guide' was imported from git, so uploads stay previews unless you pass --promote.",
    );

    // An explicit --promote is a hotfix: promote travels with the upload, and
    // the output says production has drifted from the repository.
    const hotfix = fakePlatform({
      projects: [{ id: "proj_1", slug: "tour-guide", importKind: "git" }],
      jobTimeline: BUILD_DONE,
      logTimeline: [[]],
    });
    const { io: hotfixIo, printed: hotfixPrinted } = io(hotfix, {
      baseCommitSha: "d".repeat(40),
      dirty: true,
    });
    const promoted = await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      promote: true,
      io: hotfixIo,
    });
    expect(promoted).toMatchObject({ importKind: "git", promoted: true });
    const hotfixSync = hotfix.calls.find((call) => call.url.includes("/sync-source"));
    expect(hotfixSync?.form?.get("promote")).toBe("true");
    expect(hotfixPrinted.join("\n")).toContain("Promoting a hotfix: 'tour-guide'");
    expect(hotfixPrinted).toContain(PROMOTED_LINE);
    expect(hotfixPrinted.join("\n")).toContain("Production has drifted from the repository");
  });

  test("follows its own build job when a concurrent deploy runs on the same project", async () => {
    // A Dashboard deploy queued alongside ours: newer (listed first), fails,
    // and would have produced a different deployment. Neither its failure
    // nor its deployment may be attributed to this CLI run.
    const dashboardBuild = (status: string, extra: Partial<FakeJob> = {}): FakeJob => ({
      id: "job_dash",
      type: "build_deploy",
      status,
      lastError: null,
      parentJobId: null,
      deploymentId: null,
      ...extra,
    });
    const platform = fakePlatform({
      projects: [{ id: "proj_1", slug: "tour-guide", importKind: "zip" }],
      jobTimeline: [
        [IMPORT_DONE],
        [dashboardBuild("running"), OUR_BUILD("running"), IMPORT_DONE],
        [
          dashboardBuild("completed", { deploymentId: "dep_dash" }),
          OUR_BUILD("running"),
          IMPORT_DONE,
        ],
        [
          dashboardBuild("failed", { lastError: "Dashboard build exploded" }),
          OUR_BUILD("completed", "dep_new"),
          IMPORT_DONE,
        ],
      ],
      logTimeline: [[]],
    });

    const result = await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      promote: true,
      io: io(platform).io,
    });

    expect(result.deploymentId).toBe("dep_new");
  });

  test("fails clearly when its build job does not name the deployment it produced", async () => {
    const platform = fakePlatform({
      jobTimeline: [[IMPORT_DONE], [OUR_BUILD("completed", null), IMPORT_DONE]],
      logTimeline: [[]],
    });
    await expect(
      runDeploy({
        origin: "http://localhost:17300",
        token: "tok",
        dir: await makeProject(),
        promote: true,
        io: io(platform).io,
      }),
    ).rejects.toThrow(/did not record which deployment it produced/);
    expect(platform.calls.some((call) => call.url.endsWith("/deployments"))).toBe(false);
  });

  test("refuses out-of-window eve before uploading", async () => {
    const platform = fakePlatform({});
    await expect(
      runDeploy({
        origin: "http://localhost:17300",
        token: "tok",
        dir: await makeProject("0.46.0"),
        promote: true,
        io: io(platform).io,
      }),
    ).rejects.toThrow(/outside this instance's supported window/);
    expect(platform.calls.every((call) => call.method === "GET")).toBe(true);
  });

  test("surfaces a failed build's lastError and honors --no-promote", async () => {
    const failing = fakePlatform({
      jobTimeline: [
        [
          {
            id: "job_i",
            type: "import_source",
            status: "failed",
            lastError: "Invalid eve project: boom",
          },
        ],
      ],
      logTimeline: [[]],
    });
    await expect(
      runDeploy({
        origin: "http://localhost:17300",
        token: "tok",
        dir: await makeProject(),
        promote: true,
        io: io(failing).io,
      }),
    ).rejects.toThrow(/Import failed: Invalid eve project: boom/);

    const preview = fakePlatform({
      projects: [{ id: "proj_1", slug: "tour-guide", importKind: "zip" }],
      jobTimeline: BUILD_DONE,
      logTimeline: [[]],
    });
    const { io: previewIo, printed } = io(preview);
    const result = await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      promote: false,
      io: previewIo,
    });
    expect(result).toMatchObject({ promoted: false, deploymentId: "dep_new" });
    const sync = preview.calls.find((call) => call.url.includes("/sync-source"));
    expect(sync?.form?.get("promote")).toBeNull();
    expect(preview.calls.some((call) => call.url.includes("/promote"))).toBe(false);
    expect(printed).not.toContain(PROMOTED_LINE);
    expect(printed.join("\n")).toContain("--no-promote");
  });

  test("a failed preflight never creates a project or burns the slug", async () => {
    const platform = fakePlatform({
      preflightOutcome: {
        status: "failed",
        error: 'Invalid eve project: Unsupported Eve dependency "0.47.99".',
      },
    });
    await expect(
      runDeploy({
        origin: "http://localhost:17300",
        token: "tok",
        dir: await makeProject(),
        promote: true,
        io: io(platform).io,
      }),
    ).rejects.toThrow(/Source validation failed: Invalid eve project/);
    expect(
      platform.calls.some((call) => call.method === "POST" && call.url.endsWith("/api/projects")),
    ).toBe(false);
  });

  test("derives slugs the platform accepts", () => {
    expect(projectSlugFrom(undefined, "My Tour Guide!")).toBe("my-tour-guide");
    expect(projectSlugFrom("explicit-name", "ignored")).toBe("explicit-name");
    expect(projectSlugFrom(undefined, "x".repeat(80))).toHaveLength(53);
    expect(() => projectSlugFrom(undefined, "___")).toThrow(/Cannot derive/);
  });
});
