import { existsSync, globSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
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
    expect(layout).toContain("<SidebarTrigger />")
    expect(layout).toContain('className="md:hidden"')
  })

  test("shows the Eveland version in the sidebar and full Web/API build details in About", () => {
    const aboutUrl = new URL("./settings/about/page.tsx", import.meta.url)
    const sidebar = source("../components/app-sidebar.tsx")
    const serverApi = source("../lib/server-api.ts")

    expect(sidebar).toContain('import { EVELAND_VERSION } from "@eveland/core/build-info"')
    expect(sidebar).toContain("Eveland v{EVELAND_VERSION}")
    expect(sidebar).toContain('href="/settings/about"')
    expect(serverApi).toContain("export const getApiBuildInfo")
    expect(existsSync(fileURLToPath(aboutUrl))).toBe(true)
    if (!existsSync(fileURLToPath(aboutUrl))) return

    const about = source("./settings/about/page.tsx")
    expect(about).toContain('createBuildInfoFromEnv("web", process.env)')
    expect(about).toContain("getApiBuildInfo")
    expect(about).toContain("isSameBuild")
    expect(about).toContain("<Card")
    expect(about).toContain("<CardHeader")
    expect(about).toContain("<CardContent")
    expect(about).toContain("<Badge")
    expect(about).toContain("<Table")
    expect(about).toContain("<Alert")
    expect(about).toContain("Runtime configuration")
    expect(about).toContain("getSystemConfigurationDiagnostics")
    expect(about).toContain('currentMember.role === "admin"')
    expect(about).toContain("Effective value")
    expect(about).toContain("Secrets are never returned")
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

  test("surfaces the persisted project deletion lifecycle with a typed destructive confirmation", () => {
    const deleteActionUrl = new URL("../components/delete-project-action.tsx", import.meta.url)

    expect(existsSync(fileURLToPath(deleteActionUrl))).toBe(true)
    const deleteAction = source("../components/delete-project-action.tsx")
    const projects = source("./projects/page.tsx")
    const projectLayout = source("./projects/[projectId]/layout.tsx")
    const projectOverview = source("./projects/[projectId]/page.tsx")
    const clientApi = source("../lib/client-api.ts")

    expect(deleteAction).toContain("<AlertDialog")
    expect(deleteAction).toContain("confirmation === projectName")
    expect(deleteAction).toContain("<Field")
    expect(deleteAction).toContain("<Input")
    expect(deleteAction).toContain("<Spinner")
    expect(deleteAction).toContain('router.replace("/projects")')
    expect(projects).toContain("<DeleteProjectAction")
    expect(projects).toContain("<ProjectDeletionPoller")
    expect(projects).toContain("project.deletionStatus")
    expect(projectLayout).toContain("<ProjectDeletionNotice")
    expect(projectLayout).toContain("disabled={project.deletionStatus === 'deleting'}")
    expect(projectOverview).toContain("<ProjectDangerZone")
    expect(clientApi).toContain("export async function deleteProject")
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
    expect(newProject).toContain("buttonVariants({ variant: 'ghost' })")
  })

  test("derives a URL-friendly project name after the source is entered", () => {
    const forms = source("../components/new-project-forms.tsx")

    expect(forms).toContain("inferProjectSlugFromGitUrl")
    expect(forms.indexOf("Git repository URL")).toBeLessThan(forms.indexOf("Project name"))
    expect(forms).toContain("PROJECT_SLUG_PATTERN")
    expect(forms).toContain("data-invalid")
    expect(forms).toContain("aria-invalid")
  })

  test("composes the project import forms from installed shadcn components", () => {
    const forms = source("../components/new-project-forms.tsx")

    expect(forms).toContain("<Card")
    expect(forms).toContain("<CardHeader")
    expect(forms).toContain("<CardContent")
    expect(forms).toContain("<CardFooter")
    expect(forms).toContain("<FieldGroup")
    expect(forms).toContain("<Field")
    expect(forms).toContain("<Input")
    expect(forms).toContain("<Spinner")
    expect(forms).not.toContain("<input")
  })

  test("keeps links semantic when they use button styling", () => {
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url))
    const violations = globSync("**/*.tsx", { cwd: sourceRoot }).filter((path) =>
      /<Button\b[^>]*render=\{<Link\b/s.test(readFileSync(resolve(sourceRoot, path), "utf8")),
    )

    expect(violations).toEqual([])
  })

  test("merges tooltip behavior into the existing AI Element buttons", () => {
    for (const path of [
      "../components/ai-elements/message.tsx",
      "../components/ai-elements/prompt-input.tsx",
    ]) {
      const component = source(path)

      expect(component).toContain("<TooltipTrigger render={button} />")
      expect(component).not.toContain("<TooltipTrigger>{button}</TooltipTrigger>")
    }
  })

  test("does not leave a blank grid cell in the project deployment summary", () => {
    const projectOverview = source("./projects/[projectId]/page.tsx")

    expect(projectOverview).toContain("last:col-span-2")
  })

  test("shows deployment timestamps in the project traffic list", () => {
    const projectOverview = source("./projects/[projectId]/page.tsx")

    expect(projectOverview).toContain("<time dateTime={deployment.createdAt}>")
    expect(projectOverview).toContain("Deployed {new Date(deployment.createdAt).toLocaleString()}")
  })

  test("marks stable route targets with their production traffic weight", () => {
    const projectOverview = source("./projects/[projectId]/page.tsx")

    expect(projectOverview).toContain("stableRoute?.targets.find((target) => target.deploymentId === deployment.id)")
    expect(projectOverview).toContain("<BadgeCheckIcon data-icon=\"inline-start\" />")
    expect(projectOverview).toContain("Stable · {stableTarget.weight / 100}% traffic")
    expect(projectOverview).not.toContain("project?.deploymentId === deployment.id ? <span")
  })

  test("explains when saving a secret queued live deployment restarts", () => {
    const secretForm = source("../components/secret-form.tsx")

    expect(secretForm).toContain("result.jobs.length > 0")
    expect(secretForm).toContain("Restarting live deployments")
    expect(secretForm).toContain("used by the next deployment")
  })

  test("subscribes to mobile media-query changes", () => {
    const useMobile = source("../hooks/use-mobile.ts")

    expect(useMobile).toContain('mql.addEventListener("change", onChange)')
    expect(useMobile).toContain('mql.removeEventListener("change", onChange)')
  })

  test("renders Playground as a fresh AI Elements conversation instead of a debug timeline", () => {
    const playground = source("../components/playground-panel.tsx")
    const nextConfig = source("../../next.config.ts")

    for (const path of [
      "../components/ai-elements/attachments.tsx",
      "../components/ai-elements/confirmation.tsx",
      "../components/ai-elements/conversation.tsx",
      "../components/ai-elements/message.tsx",
      "../components/ai-elements/prompt-input.tsx",
      "../components/ai-elements/reasoning.tsx",
      "../components/ai-elements/tool.tsx",
    ]) {
      expect(existsSync(fileURLToPath(new URL(path, import.meta.url)))).toBe(true)
    }
    expect(playground).toContain("useEveAgent")
    expect(playground).toContain("preserveCompletedSessions: true")
    expect(playground).toContain("<Conversation")
    expect(playground).toContain("<MessageResponse")
    expect(playground).toContain("<Reasoning")
    expect(playground).toContain("<Tool")
    expect(playground).toContain("<Confirmation")
    expect(playground).toContain("<PromptInput")
    expect(playground).toContain("PromptInputActionAddAttachments")
    expect(playground).not.toContain("TimelineEvent")
    expect(playground).not.toContain("Current session")
    expect(playground).not.toContain("<pre")
    expect(nextConfig).toContain('source: "/api/eveland/:path*"')
  })

  test("renders session replay as a chat conversation with a raw event toggle", () => {
    const page = source("./projects/[projectId]/sessions/[sessionId]/page.tsx")
    const replay = source("../components/session-replay.tsx")

    expect(page).toContain("<SessionReplay")
    expect(page).not.toContain("<pre")
    expect(replay).toContain("buildSessionTranscript")
    expect(replay).toContain("<MessageResponse")
    expect(replay).toContain("<Reasoning")
    expect(replay).toContain("<Tool")
    expect(replay).toContain("<ToolHeader")
    expect(replay).toContain('setView("raw")')
    expect(replay).toContain("<RawView")
  })
})
