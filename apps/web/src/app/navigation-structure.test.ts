import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
}

describe("web application shell", () => {
  test("uses the shadcn sidebar shell in the root layout", () => {
    const layout = source("./layout.tsx")

    expect(layout).toContain("<SidebarProvider")
    expect(layout).toContain("<AppSidebar")
    expect(layout).toContain("<SidebarInset")
  })

  test("renders project navigation as a shadcn sidebar menu", () => {
    const projectNav = source("../components/project-nav.tsx")

    expect(projectNav).toContain("<SidebarMenu")
    expect(projectNav).toContain("<SidebarMenuButton")
    expect(projectNav).not.toContain("<nav")
  })

  test("provides populated global deployment and usage pages plus project usage", () => {
    const deploymentsUrl = new URL("./deployments/page.tsx", import.meta.url)
    const usageUrl = new URL("./usage/page.tsx", import.meta.url)
    const projectUsageUrl = new URL("./projects/[projectId]/usage/page.tsx", import.meta.url)

    expect(existsSync(fileURLToPath(deploymentsUrl))).toBe(true)
    expect(existsSync(fileURLToPath(usageUrl))).toBe(true)
    expect(existsSync(fileURLToPath(projectUsageUrl))).toBe(true)
    expect(source("./deployments/page.tsx")).toContain("getDeploymentOverview")
    expect(source("./usage/page.tsx")).toContain("summarizeTokenUsage")
    expect(source("./projects/[projectId]/usage/page.tsx")).toContain("summarizeTokenUsage")
  })

  test("uses shadcn project cards with complete card composition", () => {
    const projects = source("./projects/page.tsx")
    const statusBadge = source("../components/status-badge.tsx")

    expect(projects).toContain("<Alert")
    expect(projects).toContain("<Card")
    expect(projects).toContain("<CardHeader")
    expect(projects).toContain("<CardContent")
    expect(projects).toContain("<CardFooter")
    expect(projects).not.toContain("<Table")
    expect(projects).toContain("w-full items-center justify-between gap-3 sm:w-auto")
    expect(projects).toContain("<Empty")
    expect(statusBadge).toContain("<Badge")
  })

  test("removes the project summary and renders highlighted source code", () => {
    const sourcePage = source("./projects/[projectId]/source/page.tsx")

    expect(sourcePage).not.toContain("eve project summary")
    expect(sourcePage).not.toContain("getSourceRevision")
    expect(sourcePage).toContain("highlightSourceCode")
    expect(sourcePage).toContain("<Card")
  })

  test("keeps the new-project screen inside the sidebar main region", () => {
    const newProject = source("./projects/new/page.tsx")

    expect(newProject).not.toContain("<main")
    expect(newProject).toContain("<Button")
  })

  test("does not leave a blank grid cell in the project deployment summary", () => {
    const projectOverview = source("./projects/[projectId]/page.tsx")

    expect(projectOverview).toContain("last:col-span-2")
  })

  test("updates mobile sidebar state even when media-query listeners are unavailable", () => {
    const useMobile = source("../hooks/use-mobile.ts")

    expect(useMobile).toContain('typeof mql.addEventListener === "function"')
    expect(useMobile).toContain('typeof mql.addListener === "function"')
  })
})
