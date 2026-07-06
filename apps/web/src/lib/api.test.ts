import { afterEach, describe, expect, test, vi } from "vitest";
import { enqueueBuildDeploy } from "./api";

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
});
