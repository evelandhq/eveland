import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const projectPage = "./projects/[projectId]/deployments/page.tsx";
const allProjectsPage = "./(main)/deployments/page.tsx";

describe("project deployments surface", () => {
  test("keeps archived deployments behind a disclosure instead of listing the whole history", () => {
    const page = source(projectPage);

    // The default read model is the live deployments; the archived ones --
    // which nothing on this page can act on -- arrive only when asked for.
    expect(page).toContain('query.archived === "1"');
    expect(page).toContain('showArchived ? { archived: "true", limit: "200" } : {}');
    expect(page).toContain("overview.archivedCount");
    expect(page).toContain("Show archived");
    expect(page).toContain("Hide archived");
  });

  test("asks core whether a deployment's Eve refusal is worth showing", () => {
    const page = source(projectPage);

    // The archived-first ordering lives in core beside the activation gates;
    // the page must not re-derive it from the raw release message, which has
    // no opinion about status.
    expect(page).toContain("displayedDeploymentEveRefusal");
    expect(page).not.toContain("unsupportedReleaseEveVersionMessage");
  });

  test("decides drain from the routes that actually carry traffic", () => {
    const page = source(projectPage);
    const actions = source("../components/deployment-traffic-actions.tsx");

    // Same predicate the API's 409 uses: any non-deployment route with weight.
    expect(page).toContain('route.kind !== "deployment"');
    expect(page).toContain("target.weight > 0");
    expect(page).toContain("routed={routedDeploymentIds.has(deployment.id)}");
    expect(actions).toContain('const canDrain = status === "running" && !routed;');
  });

  test("renders only the actions a deployment can actually run", () => {
    const actions = source("../components/deployment-traffic-actions.tsx");

    // Rows used to carry three permanently greyed buttons each. `disabled` is
    // now reserved for transient state and the retention hold the row explains.
    expect(actions).toContain('const canPromote = status === "running";');
    expect(actions).toContain(
      'const canArchive = status !== "archived" && status !== "archiving";',
    );
    expect(actions).not.toContain('disabled={busy || status !== "running"}');
  });
});

describe("all-projects deployments surface", () => {
  test("opts back into the archived rows its description promises", () => {
    const page = source(allProjectsPage);

    expect(page).toContain("including archived and failed releases");
    expect(page).toContain('archived: "true"');
    // A per-project cap means the row count is not the history count.
    expect(page).toContain("overview.totalCount");
  });
});
