import { describe, expect, test } from "vitest"
import {
  getProjectIdFromPathname,
  getProjectNavigationItems,
  getSettingsNavigationGroups,
  globalNavigationItems,
  isNavigationItemActive,
  settingsNavigationGroups,
} from "./navigation"

function settingsDestinations(
  groups: ReturnType<typeof getSettingsNavigationGroups>,
) {
  return groups.flatMap((group) => group.items.map((item) => item.href))
}

describe("sidebar navigation", () => {
  test("keeps account and system settings out of the primary workspace navigation", () => {
    expect(
      globalNavigationItems.map(({ href, label }) => ({ href, label })),
    ).toEqual([
      { href: "/projects", label: "Projects" },
      { href: "/deployments", label: "Deployments" },
      { href: "/usage", label: "Usage" },
    ])
  })

  test("groups personal and system destinations for the settings sidebar", () => {
    expect(
      settingsNavigationGroups.map((group) => ({
        label: group.label,
        items: group.items.map(({ href, label }) => ({ href, label })),
      })),
    ).toEqual([
      {
        label: "Personal",
        items: [
          { href: "/settings/profile", label: "Profile" },
          { href: "/settings/git-credentials", label: "Git credentials" },
        ],
      },
      {
        label: "System",
        items: [
          { href: "/settings/members", label: "Members" },
          { href: "/settings/identity", label: "Identity" },
          {
            href: "/settings/shared-agent-environment",
            label: "Shared agent environment",
          },
          { href: "/settings/observability", label: "Observability" },
          { href: "/settings/health", label: "Instance health" },
          { href: "/settings/about", label: "About" },
        ],
      },
    ])
  })

  test("shows administrator settings only to administrators", () => {
    const memberHrefs = [
      "/settings/profile",
      "/settings/git-credentials",
      "/settings/members",
      "/settings/about",
    ]

    expect(settingsDestinations(getSettingsNavigationGroups("member"))).toEqual(
      memberHrefs,
    )
    expect(settingsDestinations(getSettingsNavigationGroups(null))).toEqual(
      memberHrefs,
    )
    expect(settingsDestinations(getSettingsNavigationGroups("admin"))).toEqual(
      settingsNavigationGroups.flatMap((group) =>
        group.items.map((item) => item.href),
      ),
    )
  })

  test("switches to project navigation for project routes but not the new-project route", () => {
    expect(getProjectIdFromPathname("/projects/project-123/usage")).toBe(
      "project-123",
    )
    expect(getProjectIdFromPathname("/projects/new")).toBeNull()
    expect(getProjectIdFromPathname("/usage")).toBeNull()
  })

  test("orders daily project destinations before management destinations", () => {
    expect(
      getProjectNavigationItems("project-123").map(
        ({ href, label, section }) => ({ href, label, section }),
      ),
    ).toEqual([
      {
        href: "/projects/project-123",
        label: "Overview",
        section: "daily",
      },
      {
        href: "/projects/project-123/playground",
        label: "Playground",
        section: "daily",
      },
      {
        href: "/projects/project-123/sessions",
        label: "Sessions",
        section: "daily",
      },
      {
        href: "/projects/project-123/logs",
        label: "Logs",
        section: "daily",
      },
      {
        href: "/projects/project-123/schedules",
        label: "Schedules",
        section: "daily",
      },
      {
        href: "/projects/project-123/usage",
        label: "Usage",
        section: "daily",
      },
      {
        href: "/projects/project-123/deployments",
        label: "Deployments",
        section: "manage",
      },
      {
        href: "/projects/project-123/source",
        label: "Source",
        section: "manage",
      },
      {
        href: "/projects/project-123/settings",
        label: "Settings",
        section: "manage",
      },
    ])
  })

  test("keeps nested project pages active without activating the overview item", () => {
    expect(
      isNavigationItemActive(
        "/projects/project-123/sessions/session-456",
        "/projects/project-123/sessions",
      ),
    ).toBe(true)
    expect(
      isNavigationItemActive(
        "/projects/project-123/sessions",
        "/projects/project-123",
      ),
    ).toBe(false)
    expect(
      isNavigationItemActive(
        "/projects/project-123",
        "/projects/project-123",
      ),
    ).toBe(true)
  })
})
