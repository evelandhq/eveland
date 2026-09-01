import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const titledPages = [
  ["./accept-invite/page.tsx", "Accept invitation"],
  ["./agent-auth/oidc/callback/layout.tsx", "Playground authentication"],
  ["./(main)/deployments/page.tsx", "Deployments"],
  ["./device/page.tsx", "Device authorization"],
  ["./login/page.tsx", "Sign in"],
  ["./new/page.tsx", "New project"],
  ["./(main)/projects/page.tsx", "Projects"],
  ["./reset-password/page.tsx", "Reset password"],
  ["./(main)/usage/page.tsx", "Usage"],
  ["./settings/about/page.tsx", "About"],
  ["./settings/git-credentials/page.tsx", "Git credentials"],
  ["./settings/health/page.tsx", "Instance health"],
  ["./settings/members/page.tsx", "Members"],
  ["./settings/observability/page.tsx", "Observability"],
  ["./settings/profile/page.tsx", "Profile"],
  ["./settings/shared-agent-environment/page.tsx", "Environment"],
  ["./projects/[projectId]/logs/page.tsx", "Logs"],
  ["./projects/[projectId]/page.tsx", "Overview"],
  ["./projects/[projectId]/playground/page.tsx", "Playground"],
  ["./projects/[projectId]/schedules/page.tsx", "Schedules"],
  ["./projects/[projectId]/deployments/page.tsx", "Deployments"],
  ["./projects/[projectId]/settings/page.tsx", "Settings"],
  ["./projects/[projectId]/sessions/page.tsx", "Sessions"],
  ["./projects/[projectId]/source/page.tsx", "Source"],
  ["./projects/[projectId]/usage/page.tsx", "Usage"],
] as const;

describe("page metadata", () => {
  test("gives every rendered page its own title", () => {
    for (const [relativePath, title] of titledPages) {
      const url = new URL(relativePath, import.meta.url);
      expect(existsSync(fileURLToPath(url)), relativePath).toBe(true);
      if (!existsSync(fileURLToPath(url))) continue;

      expect(source(relativePath), relativePath).toMatch(new RegExp(`title:\\s*["']${title}["']`));
    }
  });

  test("composes project titles from the page and project name", () => {
    const rootLayout = source("./layout.tsx");
    const projectLayout = source("./projects/[projectId]/layout.tsx");

    expect(rootLayout).toContain('default: "Eveland"');
    expect(rootLayout).toContain('template: "%s | Eveland"');
    expect(projectLayout).toContain("export async function generateMetadata");
    expect(projectLayout).toContain("getProject(projectId)");
    expect(projectLayout).toContain("template: `%s · ${project.name} | Eveland`");
  });

  test("identifies dynamic detail pages in their titles", () => {
    expect(source("./projects/[projectId]/sessions/[sessionId]/page.tsx")).toContain(
      "title: `Session ${sessionId}`",
    );
    expect(source("./projects/[projectId]/schedule-runs/[scheduleRunId]/page.tsx")).toContain(
      "title: `Schedule run ${scheduleRunId}`",
    );
  });

  test("shows the Dashboard and API build identities on the About page", () => {
    const aboutPage = source("./settings/about/page.tsx");

    expect(aboutPage).toContain("Components");
    expect(aboutPage).toContain("[webBuild, ...(apiBuild ? [apiBuild] : [])].map");
    expect(aboutPage).toContain("{build.component}");
  });
});
