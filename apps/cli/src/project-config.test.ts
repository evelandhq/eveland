import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { linkProject, resolveProjectConfig } from "./project-config.js";

describe("CLI project configuration", () => {
  test("resolves project and instance URL with flags before environment and local link", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-config-"));
    await mkdir(path.join(root, ".eveland"));
    await writeFile(
      path.join(root, ".eveland", "project.json"),
      JSON.stringify({ projectId: "proj_linked", instanceUrl: "https://linked.example.com" }),
    );

    await expect(
      resolveProjectConfig(root, {
        projectId: "proj_flag",
        instanceUrl: "https://flag.example.com/",
        env: {
          EVELAND_PROJECT_ID: "proj_env",
          EVELAND_URL: "https://env.example.com",
        },
      }),
    ).resolves.toEqual({
      projectId: "proj_flag",
      instanceUrl: "https://flag.example.com",
      linked: true,
    });
  });

  test("writes only non-secret link metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eveland-cli-link-"));

    await linkProject(root, {
      projectId: "proj_weather",
      instanceUrl: "https://eveland.example",
    });

    const resolved = await resolveProjectConfig(root, { env: {} });
    expect(resolved).toEqual({
      projectId: "proj_weather",
      instanceUrl: "https://eveland.example",
      linked: true,
    });
    await expect(readFile(path.join(root, ".gitignore"), "utf8")).resolves.toContain(
      ".eveland/",
    );
  });
});
