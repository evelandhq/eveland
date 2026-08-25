import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

function source(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  expect(existsSync(fileURLToPath(url)), relativePath).toBe(true);
  return existsSync(fileURLToPath(url)) ? readFileSync(fileURLToPath(url), "utf8") : "";
}

describe("dashboard layout boundaries", () => {
  test("shares one main layout across the three workspace routes", () => {
    const rootLayout = source("./layout.tsx");
    const mainLayout = source("./(main)/layout.tsx");
    const mainSidebar = source("../components/main-sidebar.tsx");

    for (const path of [
      "./(main)/projects/page.tsx",
      "./(main)/deployments/page.tsx",
      "./(main)/usage/page.tsx",
    ]) {
      source(path);
    }

    expect(rootLayout).not.toContain("<AppShell");
    expect(mainLayout).toContain("<SidebarShell");
    expect(mainLayout).toContain("<MainSidebar");
    expect(mainSidebar).toContain("<SproutIcon");
    expect(mainSidebar).toContain("globalNavigationItems.map");
    expect(mainSidebar).toContain("<SidebarFooter>");
    expect(mainSidebar).toContain("<AvatarFallback>");
  });

  test("gives project details a project-only sidebar", () => {
    const projectLayout = source("./projects/[projectId]/layout.tsx");
    const projectSidebar = source("../components/project-sidebar.tsx");

    expect(projectLayout).toContain("<SidebarShell");
    expect(projectLayout).toContain("<ProjectSidebar");
    expect(projectLayout).not.toContain("<ProjectBreadcrumb");
    expect(projectSidebar).toContain('href="/projects"');
    expect(projectSidebar).toContain("<ArrowLeftIcon");
    expect(projectSidebar).toContain("<ProjectNav");
    expect(projectSidebar).not.toContain("<SidebarFooter");
    expect(projectSidebar).not.toContain("<Avatar");
  });

  test("renders project settings as one centered page", () => {
    const settingsPage = source("./projects/[projectId]/settings/page.tsx");

    expect(settingsPage).toContain('title: "Settings"');
    expect(settingsPage).toContain('className="mx-auto flex w-full max-w-4xl flex-col gap-6"');
    expect(settingsPage).toContain(">Settings</h2>");
    expect(settingsPage).toContain("<ProjectGeneralSettings");
    expect(settingsPage).toContain("<ProjectSecretsSettings");
    expect(settingsPage).toContain("<ProjectDangerZone");
    expect(settingsPage).toContain("<Separator");
    expect(settingsPage).not.toContain("<ProjectSettingsNav");
  });

  test("gives settings a settings-only sidebar", () => {
    const settingsLayout = source("./settings/layout.tsx");
    const settingsSidebar = source("../components/settings-sidebar.tsx");

    expect(settingsLayout).toContain("<SidebarShell");
    expect(settingsLayout).toContain("<SettingsSidebar");
    expect(settingsSidebar).toContain('href="/projects"');
    expect(settingsSidebar).toContain("<ArrowLeftIcon");
    expect(settingsSidebar).toContain("getSettingsNavigationGroups");
    expect(settingsSidebar).not.toContain("<SidebarFooter");
    expect(settingsSidebar).not.toContain("<Avatar");
  });
});
