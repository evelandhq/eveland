import { describe, expect, test } from "vitest"

type NavigationModule = {
  getProjectIdFromPathname(pathname: string): string | null
  isNavigationItemActive(pathname: string, href: string): boolean
  globalNavigationItems: ReadonlyArray<{ href: string; label: string }>
  getProjectNavigationItems(projectId: string): ReadonlyArray<{ href: string; label: string }>
}

async function loadNavigationModule(): Promise<NavigationModule | null> {
  const modulePath = "./navigation"
  return import(modulePath).catch(() => null) as Promise<NavigationModule | null>
}

describe("sidebar navigation", () => {
  test("provides the global Projects, Deployments, and Usage destinations", async () => {
    const navigation = await loadNavigationModule()

    expect(navigation).not.toBeNull()
    expect(navigation?.globalNavigationItems.map(({ href, label }) => ({ href, label }))).toEqual([
      { href: "/projects", label: "Projects" },
      { href: "/deployments", label: "Deployments" },
      { href: "/usage", label: "Usage" },
    ])
  })

  test("switches to project navigation for project routes but not the new-project route", async () => {
    const navigation = await loadNavigationModule()

    expect(navigation).not.toBeNull()
    expect(navigation?.getProjectIdFromPathname("/projects/project-123/usage")).toBe("project-123")
    expect(navigation?.getProjectIdFromPathname("/projects/new")).toBeNull()
    expect(navigation?.getProjectIdFromPathname("/usage")).toBeNull()
  })

  test("adds Usage to the existing project destinations", async () => {
    const navigation = await loadNavigationModule()

    expect(navigation).not.toBeNull()
    expect(navigation?.getProjectNavigationItems("project-123").map(({ href, label }) => ({ href, label }))).toEqual([
      { href: "/projects/project-123", label: "Overview" },
      { href: "/projects/project-123/playground", label: "Playground" },
      { href: "/projects/project-123/sessions", label: "Sessions" },
      { href: "/projects/project-123/usage", label: "Usage" },
      { href: "/projects/project-123/schedules", label: "Schedules" },
      { href: "/projects/project-123/source", label: "Source" },
      { href: "/projects/project-123/secrets", label: "Secrets" },
      { href: "/projects/project-123/logs", label: "Logs" },
    ])
  })

  test("keeps nested project pages active without activating the overview item", async () => {
    const navigation = await loadNavigationModule()

    expect(navigation).not.toBeNull()
    expect(navigation?.isNavigationItemActive("/projects/project-123/sessions/session-456", "/projects/project-123/sessions")).toBe(true)
    expect(navigation?.isNavigationItemActive("/projects/project-123/sessions", "/projects/project-123")).toBe(false)
    expect(navigation?.isNavigationItemActive("/projects/project-123", "/projects/project-123")).toBe(true)
  })
})
