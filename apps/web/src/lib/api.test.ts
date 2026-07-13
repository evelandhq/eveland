import { afterEach, describe, expect, test, vi } from "vitest";
import { enqueueBuildDeploy, syncSource } from "./client-api";

describe("web api helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("enqueues a build deploy job for a project", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ job: { id: "job_123", type: "build_deploy", status: "queued" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
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

  test("syncs source and asks the API to deploy the latest commit", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ job: { id: "job_sync", type: "import_source", status: "queued" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncSource("proj_123", { deploy: true })).resolves.toMatchObject({
      id: "job_sync",
      type: "import_source",
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/projects/proj_123/sync-source", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploy: true }),
    });
  });

  test("throws the API error when a source sync fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "Only git projects can sync source from a repository." }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await expect(syncSource("proj_zip")).rejects.toThrow("Only git projects can sync source");
  });

});
