import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { FetchLike } from "./api-client.ts";
import { projectSlugFrom, runDeploy } from "./deploy.ts";

async function makeProject(eve = "0.47.6", name = "tour-guide"): Promise<string> {
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

/**
 * A scripted platform: fixed instance window, a mutable project/job/log
 * state the test advances between polls.
 */
function fakePlatform(options: {
  projects?: Array<{ id: string; slug: string; importKind: string }>;
  preexistingJobs?: Array<{ id: string; type: string; status: string; lastError: null }>;
  jobTimeline?: Array<
    Array<{ id: string; type: string; status: string; lastError: string | null }>
  >;
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
  // The baseline jobs/logs snapshot happens before the upload; new activity
  // only appears once the deploy has been submitted.
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
        eve: { supportedRanges: ["0.45.x", "0.47.x"], expected: "0.45.x or 0.47.x" },
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
      return json(202, { job: { id: "job_sync", type: "import_source", status: "queued" } });
    }
    if (pathname.endsWith("/jobs")) {
      expect(searchParams.get("include")).toBe("deployment");
      if (!submitted) return json(200, { jobs: options.preexistingJobs ?? [] });
      const step = Math.min(polls, jobTimeline.length - 1);
      const timeline = jobTimeline[step] ?? [];
      return json(200, { jobs: [...(options.preexistingJobs ?? []), ...timeline] });
    }
    if (pathname.endsWith("/logs")) {
      // Bounded reads only: the client must always send limit or after.
      expect(searchParams.get("limit") ?? searchParams.get("after")).not.toBeNull();
      const respond = () => {
        const after = searchParams.get("after");
        if (after) {
          const anchor = emittedLogs.findIndex((log) => log.id === after);
          return json(200, { logs: anchor === -1 ? [] : emittedLogs.slice(anchor + 1) });
        }
        const limit = Number(searchParams.get("limit") ?? emittedLogs.length);
        return json(200, { logs: emittedLogs.slice(-limit) });
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
    if (pathname.endsWith("/deployments")) {
      return json(200, { deployments: [{ id: "dep_new", status: "running" }] });
    }
    if (pathname.endsWith("/promote")) {
      return json(200, { route: {} });
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

function io(platform: ReturnType<typeof fakePlatform>) {
  const printed: string[] = [];
  return {
    printed,
    io: {
      fetchImpl: platform.fetchImpl,
      print: (line: string) => printed.push(line),
      sleep: async () => {},
    },
  };
}

const BUILD_DONE = [
  [{ id: "job_i", type: "import_source", status: "completed", lastError: null }],
  [
    { id: "job_i", type: "import_source", status: "completed", lastError: null },
    { id: "job_b", type: "build_deploy", status: "running", lastError: null },
  ],
  [
    { id: "job_i", type: "import_source", status: "completed", lastError: null },
    { id: "job_b", type: "build_deploy", status: "completed", lastError: null },
  ],
];

describe("eveland deploy", () => {
  test("creates, streams build logs, and promotes a fresh project", async () => {
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
    expect(create?.jsonBody).toEqual({
      name: "tour-guide",
      preflightId: "pre_1",
      deployAfterImport: true,
    });
    expect(platform.calls.some((call) => call.url.includes("/promote"))).toBe(true);
    const output = printed.join("\n");
    expect(output).toContain("importing source");
    expect(output).toContain("eve build ok");
    // Each log line prints once despite polling the cumulative history.
    expect(printed.filter((line) => line.includes("importing source"))).toHaveLength(1);
  });

  test("redeploys an existing zip project through sync-source without replaying old logs", async () => {
    const platform = fakePlatform({
      projects: [{ id: "proj_1", slug: "tour-guide", importKind: "zip" }],
      preexistingJobs: [{ id: "job_old", type: "build_deploy", status: "failed", lastError: null }],
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

    expect(result.projectId).toBe("proj_1");
    const sync = platform.calls.find((call) => call.url.includes("/sync-source"));
    expect(sync?.form?.get("deploy")).toBe("true");
    expect(sync?.form?.get("promote")).toBeNull();
    expect(printed.join("\n")).toContain("fresh build line");
  });

  test("refuses git projects and out-of-window eve before uploading", async () => {
    const gitPlatform = fakePlatform({
      projects: [{ id: "proj_1", slug: "tour-guide", importKind: "git" }],
    });
    await expect(
      runDeploy({
        origin: "http://localhost:17300",
        token: "tok",
        dir: await makeProject(),
        promote: true,
        io: io(gitPlatform).io,
      }),
    ).rejects.toThrow(/imported from git/);

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

    const preview = fakePlatform({ jobTimeline: BUILD_DONE, logTimeline: [[]] });
    const result = await runDeploy({
      origin: "http://localhost:17300",
      token: "tok",
      dir: await makeProject(),
      promote: false,
      io: io(preview).io,
    });
    expect(result.promoted).toBe(false);
    expect(preview.calls.some((call) => call.url.includes("/promote"))).toBe(false);
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
