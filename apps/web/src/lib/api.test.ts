import { afterEach, describe, expect, test, vi } from "vitest";
import { createProjectEnvironmentEntries, enqueueBuildDeploy, syncSource } from "./client-api";
import { getProjectImportNotice, selectProjectLogs, type Job, type LogLine } from "./api";

describe("web api helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("enqueues a current-source preview build for a project", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ job: { id: "job_123", type: "build_deploy", status: "queued" } }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(enqueueBuildDeploy("proj_123")).resolves.toMatchObject({
      id: "job_123",
      type: "build_deploy",
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/projects/proj_123/build-deploy", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promote: false }),
    });
  });

  test("enqueues a current-source build with promotion", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ job: { id: "job_promote", type: "build_deploy", status: "queued" } }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(enqueueBuildDeploy("proj_123", { promote: true })).resolves.toMatchObject({
      id: "job_promote",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/projects/proj_123/build-deploy", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promote: true }),
    });
  });

  test("maps a failed import job to a visible retry notice", () => {
    const job: Job = {
      id: "job_failed",
      projectId: "proj_123",
      type: "import_source",
      status: "failed",
      payload: {},
      attempts: 1,
      lastError: "Repository fetch timed out after 120000ms.",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:02:00.000Z",
    };

    expect(getProjectImportNotice(job)).toEqual({
      active: false,
      title: "Repository fetch failed",
      detail: "Repository fetch timed out after 120000ms.",
    });
  });

  test("selects project logs by type and search text with newest entries first", () => {
    const logs: LogLine[] = [
      {
        id: "log_old",
        projectId: "proj_123",
        deploymentId: null,
        type: "build",
        line: "Installing dependencies",
        createdAt: "2026-07-21T10:00:00.000Z",
      },
      {
        id: "log_new",
        projectId: "proj_123",
        deploymentId: "dep_123",
        type: "runtime",
        line: "Runtime READY on port 41000",
        createdAt: "2026-07-21T10:02:00.000Z",
      },
      {
        id: "log_middle",
        projectId: "proj_123",
        deploymentId: "dep_123",
        type: "runtime",
        line: "Runtime stopped",
        createdAt: "2026-07-21T10:01:00.000Z",
      },
    ];

    expect(selectProjectLogs(logs, { type: "runtime", query: "ready", order: "desc" })).toEqual([
      logs[1],
    ]);
    expect(
      selectProjectLogs(logs, { type: "all", query: "", order: "asc" }).map((log) => log.id),
    ).toEqual(["log_old", "log_middle", "log_new"]);
    expect(logs.map((log) => log.id)).toEqual(["log_old", "log_new", "log_middle"]);
  });

  test("maps a queued import job to an active notice", () => {
    const job: Job = {
      id: "job_queued",
      projectId: "proj_123",
      type: "import_source",
      status: "queued",
      payload: {},
      attempts: 0,
      lastError: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };

    expect(getProjectImportNotice(job)).toEqual({
      active: true,
      title: "Repository fetch queued",
      detail: "Waiting for a worker to start fetching the repository.",
    });
  });

  test("maps a running import job to an active notice", () => {
    const job: Job = {
      id: "job_running",
      projectId: "proj_123",
      type: "import_source",
      status: "running",
      payload: {},
      attempts: 1,
      lastError: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:01.000Z",
    };

    expect(getProjectImportNotice(job)).toEqual({
      active: true,
      title: "Fetching repository…",
      detail: "The worker is cloning and validating the latest source.",
    });
  });

  test("throws the API error when build deploy enqueue fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "Project not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await expect(enqueueBuildDeploy("missing")).rejects.toThrow("Project not found");
  });

  test("syncs source and asks the API to deploy and promote the latest commit", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ job: { id: "job_sync", type: "import_source", status: "queued" } }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncSource("proj_123", { deploy: true, promote: true })).resolves.toMatchObject({
      id: "job_sync",
      type: "import_source",
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/projects/proj_123/sync-source", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploy: true, promote: true }),
    });
  });

  test("syncs source into a preview without promotion", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ job: { id: "job_preview", type: "import_source", status: "queued" } }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncSource("proj_123", { deploy: true, promote: false })).resolves.toMatchObject({
      id: "job_preview",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/projects/proj_123/sync-source", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploy: true, promote: false }),
    });
  });

  test("throws the API error when a source sync fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: "Only git projects can sync source from a repository." }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    await expect(syncSource("proj_zip")).rejects.toThrow("Only git projects can sync source");
  });

  test("sends project environment entries through the batch endpoint", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          secrets: [
            { id: "secret_1", projectId: "proj_123", key: "MODEL_NAME", kind: "variable" },
            { id: "secret_2", projectId: "proj_123", key: "OPENAI_API_KEY", kind: "secret" },
          ],
          jobs: [],
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const entries = [
      { key: "MODEL_NAME", kind: "variable" as const, value: "gpt-5.4" },
      { key: "OPENAI_API_KEY", kind: "secret" as const, value: "sk-test" },
    ];

    await expect(createProjectEnvironmentEntries("proj_123", entries)).resolves.toMatchObject({
      secrets: [
        { key: "MODEL_NAME", kind: "variable" },
        { key: "OPENAI_API_KEY", kind: "secret" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/projects/proj_123/secrets/batch",
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      },
    );
  });

  test("requests asynchronous project deletion and returns its job", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ job: { id: "job_delete", type: "delete_project", status: "queued" } }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const clientApi = await import("./client-api");

    expect(clientApi.deleteProject).toBeTypeOf("function");
    await expect(clientApi.deleteProject("proj_123")).resolves.toMatchObject({
      id: "job_delete",
      type: "delete_project",
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/projects/proj_123", {
      method: "DELETE",
      credentials: "include",
    });
  });
});
