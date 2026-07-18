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
    expect(existsSync(fileURLToPath(new URL("./members/page.tsx", import.meta.url)))).toBe(false);
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

  test("provides one global shared Agent environment without binding controls", () => {
    const environmentPageUrl = new URL("./settings/shared-agent-environment/page.tsx", import.meta.url);
    const environmentSettingsUrl = new URL("../components/shared-agent-environment-settings.tsx", import.meta.url);
    const bindingSettingsUrl = new URL("../components/shared-agent-environment-bindings.tsx", import.meta.url);
    const legacyProfilePageUrl = new URL("./settings/secret-profiles/page.tsx", import.meta.url);

    expect(existsSync(fileURLToPath(environmentPageUrl))).toBe(true);
    expect(existsSync(fileURLToPath(environmentSettingsUrl))).toBe(true);
    expect(existsSync(fileURLToPath(bindingSettingsUrl))).toBe(false);
    expect(existsSync(fileURLToPath(legacyProfilePageUrl))).toBe(false);
    if (
      !existsSync(fileURLToPath(environmentPageUrl)) ||
      !existsSync(fileURLToPath(environmentSettingsUrl))
    ) return;

    const environmentPage = source("./settings/shared-agent-environment/page.tsx");
    expect(environmentPage).toContain("getSharedAgentEnvironment");
    expect(environmentPage).toContain("every Agent Deployment");
    const environmentSettings = source("../components/shared-agent-environment-settings.tsx");
    expect(environmentSettings).toContain("<Card");
    expect(environmentSettings).toContain("<FieldGroup");
    expect(environmentSettings).toContain("saveSharedAgentEnvironment");
    expect(environmentSettings).toContain("<Field key={index}>");
    expect(environmentSettings).not.toContain("profileName");
    const projectSecretsPage = source("./projects/[projectId]/secrets/page.tsx");
    expect(projectSecretsPage).not.toContain("SharedAgentEnvironmentBindings");
    expect(projectSecretsPage).not.toContain("getProjectSharedAgentEnvironmentBindings");
    expect(projectSecretsPage).not.toContain("getSharedAgentEnvironment");
    expect(source("../components/agent-auth-fields.tsx")).not.toContain("Secret Profile");
    expect(existsSync(fileURLToPath(new URL("../components/platform-secret-profile-settings.tsx", import.meta.url)))).toBe(false);
    expect(existsSync(fileURLToPath(new URL("../components/platform-secret-bindings.tsx", import.meta.url)))).toBe(false);
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
    const settingsLayout = source("./settings/layout.tsx");
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
    const settingsLayout = source("./settings/layout.tsx");

    expect(sidebar).toContain('pathname.startsWith("/settings")');
    expect(sidebar).toContain("settingsNavigationGroups.map");
    expect(sidebar).toContain("Back to workspace");
    expect(settingsLayout).not.toContain("SettingsNav");
    expect(settingsLayout).not.toContain("md:grid-cols");
    expect(existsSync(fileURLToPath(new URL("../components/settings-nav.tsx", import.meta.url)))).toBe(false);
  });

  test("opens settings and sign out from one semantic account menu trigger", () => {
    const sidebar = source("../components/app-sidebar.tsx");

    expect(sidebar).toContain("<DropdownMenu");
    expect(sidebar).toContain("<DropdownMenuTrigger");
    expect(sidebar).toContain("<DropdownMenuGroup");
    expect(sidebar).toContain('href="/settings/profile"');
    expect(sidebar).toContain("<AvatarFallback");
    expect(sidebar).toContain('render={<SidebarMenuButton size="lg" />}');
    expect(sidebar).not.toContain('tooltip="Account"');
    expect(sidebar).not.toContain("<SignOutButton");
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
    expect(source("../components/secret-form.tsx")).toContain('credentials: "include"');
  });
});
