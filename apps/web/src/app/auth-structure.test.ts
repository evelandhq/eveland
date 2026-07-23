import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("team management web surfaces", () => {
  test("provides login, invitation acceptance, settings, and auth proxy surfaces", () => {
    for (const path of [
      "./login/page.tsx",
      "./accept-invite/page.tsx",
      "./settings/layout.tsx",
      "./settings/profile/page.tsx",
      "./settings/git-credentials/page.tsx",
      "./settings/members/page.tsx",
      "../proxy.ts",
    ]) {
      expect(existsSync(fileURLToPath(new URL(path, import.meta.url)))).toBe(true);
    }
  });

  test("offers GitLab PAT import and personal host credential management", () => {
    const newProjectFormUrl = new URL("../components/new-project-flow.tsx", import.meta.url);
    expect(existsSync(fileURLToPath(newProjectFormUrl))).toBe(true);
    if (!existsSync(fileURLToPath(newProjectFormUrl))) return;
    const newProjectForm = source("../components/new-project-flow.tsx");
    const credentialsPageUrl = new URL("./settings/git-credentials/page.tsx", import.meta.url);
    const credentialsFormUrl = new URL("../components/git-credentials-settings.tsx", import.meta.url);

    expect(newProjectForm).toContain("GitLab personal access token");
    expect(newProjectForm).toContain("gitlabPat");
    expect(newProjectForm).toContain('type="password"');
    expect(existsSync(fileURLToPath(credentialsPageUrl))).toBe(true);
    expect(existsSync(fileURLToPath(credentialsFormUrl))).toBe(true);
    if (!existsSync(fileURLToPath(credentialsPageUrl)) || !existsSync(fileURLToPath(credentialsFormUrl))) return;
    expect(source("./settings/git-credentials/page.tsx")).toContain("getGitCredentials");
    const credentialsForm = source("../components/git-credentials-settings.tsx");
    expect(credentialsForm).toContain("<Card");
    expect(credentialsForm).toContain("<Table");
    expect(credentialsForm).toContain("<Badge");
    expect(credentialsForm).toContain("deleteGitCredential");
  });

  test("provides one global shared Agent environment", () => {
    const environmentPageUrl = new URL("./settings/shared-agent-environment/page.tsx", import.meta.url);
    const environmentSettingsUrl = new URL("../components/shared-agent-environment-settings.tsx", import.meta.url);

    expect(existsSync(fileURLToPath(environmentPageUrl))).toBe(true);
    expect(existsSync(fileURLToPath(environmentSettingsUrl))).toBe(true);
    if (
      !existsSync(fileURLToPath(environmentPageUrl)) ||
      !existsSync(fileURLToPath(environmentSettingsUrl))
    ) return;

    const environmentPage = source("./settings/shared-agent-environment/page.tsx");
    expect(environmentPage).toContain("getSharedAgentEnvironment");
    expect(environmentPage).toContain("every Agent Deployment");
    const environmentSettings = source("../components/shared-agent-environment-settings.tsx");
    expect(environmentSettings).toContain("<Card");
    expect(environmentSettings).toContain("<Table");
    expect(environmentSettings).toContain("<Dialog");
    expect(environmentSettings).toContain("<AlertDialog");
    expect(environmentSettings).toContain("<FieldGroup");
    expect(environmentSettings).toContain("saveSharedAgentEnvironment");
    expect(environmentSettings).toContain("Add entry");
    expect(environmentSettings).toContain("Edit entry");
    expect(environmentSettings).toContain("Configured");
  });

  test("provides administrator controls for Eveland capture and external OTLP destinations", () => {
    const pageUrl = new URL("./settings/observability/page.tsx", import.meta.url);
    const settingsUrl = new URL("../components/observability-settings.tsx", import.meta.url);

    expect(existsSync(fileURLToPath(pageUrl))).toBe(true);
    expect(existsSync(fileURLToPath(settingsUrl))).toBe(true);
    if (!existsSync(fileURLToPath(pageUrl)) || !existsSync(fileURLToPath(settingsUrl))) return;

    const page = source("./settings/observability/page.tsx");
    const settings = source("../components/observability-settings.tsx");
    expect(page).toContain("getObservabilitySettings");
    expect(page).toContain("getObservabilityActivity");
    expect(page).toContain('member.role !== "admin"');
    expect(settings).toContain("Built-in");
    expect(settings).toContain("Always on");
    expect(settings).toContain("Recent spans");
    expect(settings).toContain("Recent logs");
    expect(settings).toContain("saveObservabilitySettings");
    expect(settings).toContain("External destinations");
    expect(settings).toContain("createObservabilityDestination");
    expect(settings).toContain("toggleObservabilityDestination");
    expect(settings).toContain("deleteObservabilityDestination");
    expect(settings).toContain("Elastic");
    expect(settings).toContain("Langfuse");
    expect(settings).toContain("Custom OTLP");
    expect(settings).toContain("destination.health.status");
    expect(settings).toContain("<Dialog");
    expect(settings).toContain("<AlertDialog");
    expect(settings).toMatch(/User instrumentation\s+remains unchanged/);
    expect(settings).toContain("<Switch");
    expect(settings).toContain("<Input");
  });

  test("composes the settings pages from profile forms and the existing member controls", () => {
    const requiredPaths = [
      "./settings/layout.tsx",
      "./settings/profile/page.tsx",
      "../components/profile-settings-form.tsx",
      "./settings/members/page.tsx",
    ];
    for (const path of requiredPaths) {
      expect(existsSync(fileURLToPath(new URL(path, import.meta.url)))).toBe(true);
    }
    const profile = source("./settings/profile/page.tsx");
    const profileForm = source("../components/profile-settings-form.tsx");
    const members = source("./settings/members/page.tsx");
    const inviteForm = source("../components/invite-member-form.tsx");

    expect(profile).toContain("<ProfileSettingsForm");
    expect(profileForm).toContain("<Avatar");
    expect(profileForm).toContain("<FieldGroup");
    expect(profileForm).toContain('type="file"');
    expect(profileForm).toContain('autoComplete="current-password"');
    expect(profileForm).toContain('autoComplete="new-password"');
    expect(members).toContain("<Table");
    expect(members).toContain("<Badge");
    expect(members).toContain("<Card");
    expect(inviteForm).toContain("<FieldGroup");
    expect(inviteForm).toContain("<Field");
    expect(inviteForm).toContain("<Input");
  });

  test("reuses the application sidebar for settings navigation", () => {
    const sidebar = source("../components/app-sidebar.tsx");

    expect(sidebar).toContain('pathname.startsWith("/settings")');
    expect(sidebar).toContain("settingsNavigationGroups.map");
    expect(sidebar).toContain("Back to workspace");
  });

  test("opens settings and sign out from one semantic account menu trigger", () => {
    const sidebar = source("../components/app-sidebar.tsx");

    expect(sidebar).toContain("<DropdownMenu");
    expect(sidebar).toContain("<DropdownMenuTrigger");
    expect(sidebar).toContain("<DropdownMenuGroup");
    expect(sidebar).toContain('href="/settings/profile"');
    expect(sidebar).toContain("<AvatarFallback");
    expect(sidebar).toContain('render={<SidebarMenuButton size="lg" />}');
  });

  test("forwards the incoming session cookie from server components to the API", () => {
    const serverApi = source("../lib/server-api.ts");

    expect(serverApi).toContain('from "next/headers"');
    expect(serverApi).toContain("cookieStore.toString()");
  });

  test("includes credentials in direct browser project and secret mutations", () => {
    const newProjectFormUrl = new URL("../components/new-project-flow.tsx", import.meta.url);
    expect(existsSync(fileURLToPath(newProjectFormUrl))).toBe(true);
    if (!existsSync(fileURLToPath(newProjectFormUrl))) return;
    expect(source("../components/new-project-flow.tsx")).toContain('credentials: "include"');
    expect(source("../lib/client-api.ts")).toContain('credentials: "include"');
  });

  test("manages project variables and secrets with the shared table and dialog pattern", () => {
    const page = source("./projects/[projectId]/settings/environment/page.tsx");
    const settingsUrl = new URL("../components/project-secrets-settings.tsx", import.meta.url);
    expect(existsSync(fileURLToPath(settingsUrl))).toBe(true);
    if (!existsSync(fileURLToPath(settingsUrl))) return;

    const settings = source("../components/project-secrets-settings.tsx");
    expect(page).toContain("<ProjectSecretsSettings");
    expect(page).toContain("return <ProjectSecretsSettings");
    expect(settings).toContain('aria-labelledby="variables-secrets-heading"');
    expect(settings).toContain(
      "Values are encrypted and never returned after saving. Saving changes restarts live deployments; otherwise, they apply the next time this project starts.",
    );
    expect(settings).toContain("<Table");
    expect(settings).toContain("<Dialog");
    expect(settings).toContain("<AlertDialog");
    expect(settings).toContain("Type");
    expect(settings).toContain("Name");
    expect(settings).toContain("Value");
    expect(settings).toContain("Add entry");
    expect(settings).toContain("Edit entry");
  });

  test("uses the same typed entry model during new-project setup", () => {
    const newProjectForm = source("../components/new-project-flow.tsx");
    const newProjectHelpers = source("../lib/new-project.ts");

    expect(newProjectForm).toContain("type NewProjectEnvironmentVariable");
    expect(newProjectHelpers).toContain('kind: "variable" | "secret"');
    expect(newProjectForm).toContain("<Select");
    expect(newProjectForm).toContain('variable.kind === "secret" ? "Secret" : "Variable"');
    expect(newProjectForm).toContain("kind: variable.kind");
  });
});
