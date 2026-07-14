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
      "./settings/members/page.tsx",
      "../proxy.ts",
    ]) {
      expect(existsSync(fileURLToPath(new URL(path, import.meta.url)))).toBe(true);
    }
    expect(existsSync(fileURLToPath(new URL("./members/page.tsx", import.meta.url)))).toBe(false);
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
    expect(source("../components/new-project-forms.tsx").match(/credentials: "include"/g)).toHaveLength(2);
    expect(source("../components/secret-form.tsx")).toContain('credentials: "include"');
  });
});
