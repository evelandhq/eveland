import { existsSync, globSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
}

describe("web application shell", () => {
  test("keeps the anchor reset in the base layer so button link colors can override it", () => {
    const globals = source("./globals.css")

    expect(globals.indexOf("a {")).toBeGreaterThan(globals.indexOf("@layer base"))
  })

  test("uses an app shell that can remove workspace chrome for focused routes", () => {
    const layout = source("./layout.tsx")
    const appShellUrl = new URL("../components/app-shell.tsx", import.meta.url)
    expect(existsSync(fileURLToPath(appShellUrl))).toBe(true)
    if (!existsSync(fileURLToPath(appShellUrl))) return
    const appShell = source("../components/app-shell.tsx")

    expect(layout).toContain("<AppShell")
    expect(appShell).toContain('pathname === "/new"')
    expect(appShell).toContain("<SidebarProvider")
    expect(appShell).toContain("<AppSidebar")
    expect(appShell).toContain("<SidebarInset")
    expect(appShell).toContain("<SidebarTrigger />")
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

  test("provides an administrator instance health and capacity workspace", () => {
    const healthUrl = new URL("./settings/health/page.tsx", import.meta.url)
    const navigation = source("../lib/navigation.ts")
    const serverApi = source("../lib/server-api.ts")

    expect(navigation).toContain("'/settings/health'")
    expect(navigation).toContain("'Instance health'")
    expect(serverApi).toContain("export const getInstanceHealth")
    expect(existsSync(fileURLToPath(healthUrl))).toBe(true)
    if (!existsSync(fileURLToPath(healthUrl))) return

    const health = source("./settings/health/page.tsx")
    expect(health).toContain("getCurrentMember")
    expect(health).toContain('currentMember.role !== "admin"')
    expect(health).toContain("Current risks")
    expect(health).toContain("Components")
    expect(health).toContain("Capacity")
    expect(health).toContain("Workload")
    expect(health).toContain("<CapacityProgress")
    expect(health).toContain("<CapacityTrend")
    expect(health).toContain("hours={historyHours}")

    const capacityProgressUrl = new URL("../components/capacity-progress.tsx", import.meta.url)
    expect(existsSync(fileURLToPath(capacityProgressUrl))).toBe(true)
    if (existsSync(fileURLToPath(capacityProgressUrl))) {
      const capacityProgress = source("../components/capacity-progress.tsx")
      expect(capacityProgress).toContain('"use client"')
      expect(capacityProgress).toContain("<Progress")
      expect(capacityProgress).toContain("<ProgressValue")
    }
  })

  test("renders project navigation as a shadcn sidebar menu", () => {
    const projectNav = source("../components/project-nav.tsx")

    expect(projectNav).toContain("<SidebarMenu")
    expect(projectNav).toContain("<SidebarMenuButton")
  })

  test("provides populated global deployment and usage pages plus project usage", () => {
    const deploymentsUrl = new URL("./deployments/page.tsx", import.meta.url)
    const usageUrl = new URL("./usage/page.tsx", import.meta.url)
    const projectUsageUrl = new URL("./projects/[projectId]/usage/page.tsx", import.meta.url)
    const usageExplorerUrl = new URL("../components/usage/usage-explorer.tsx", import.meta.url)

    expect(existsSync(fileURLToPath(deploymentsUrl))).toBe(true)
    expect(existsSync(fileURLToPath(usageUrl))).toBe(true)
    expect(existsSync(fileURLToPath(projectUsageUrl))).toBe(true)
    expect(existsSync(fileURLToPath(usageExplorerUrl))).toBe(true)
    expect(source("./deployments/page.tsx")).toContain("getDeploymentOverview")
    expect(source("./usage/page.tsx")).toContain("getUsageAnalytics")
    expect(source("./usage/page.tsx")).toContain("<UsageExplorer")
    expect(source("./projects/[projectId]/usage/page.tsx")).toContain(
      "getProjectUsageAnalytics",
    )
    expect(source("./projects/[projectId]/usage/page.tsx")).toContain(
      "<UsageExplorer",
    )
  })

  test("uses shadcn project cards with complete card composition", () => {
    const projects = source("./projects/page.tsx")
    const statusBadge = source("../components/status-badge.tsx")

    expect(projects).toContain("<Alert")
    expect(projects).toContain("<Card")
    expect(projects).toContain("<CardHeader")
    expect(projects).toContain("<CardContent")
    expect(projects).toContain("<CardFooter")
    expect(projects).toContain("w-full items-center justify-between gap-3 sm:w-auto")
    expect(projects).toContain("<Empty")
    expect(projects).toContain("describeProjectSource")
    expect(projects).toContain("SiGithub")
    expect(projects).toContain("SiGitlab")
    expect(projects).toContain("SiGit")
    expect(projects).toContain("FolderArchiveIcon")
    expect(statusBadge).toContain("<Badge")
    expect(statusBadge).toContain("variant ??")
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
    expect(projects).not.toContain("<DeleteProjectAction")
    expect(projects).toContain("<ProjectDeletionPoller")
    expect(projects).toContain("project.deletionStatus")
    expect(projects).toContain("projectStatus === 'running' ? 'secondary'")
    expect(projectLayout).toContain("<ProjectDeletionNotice")
    expect(projectLayout).toContain("disabled={project.deletionStatus === 'deleting'}")
    expect(projectOverview).toContain("<ProjectDangerZone")
    expect(clientApi).toContain("export async function deleteProject")
  })

  test("renders highlighted source code", () => {
    const sourcePage = source("./projects/[projectId]/source/page.tsx")

    expect(sourcePage).toContain("highlightSourceCode")
    expect(sourcePage).toContain("<Card")
  })

  test("gives new-project creation a focused full-screen route", () => {
    const newProjectUrl = new URL("./new/page.tsx", import.meta.url)
    expect(existsSync(fileURLToPath(newProjectUrl))).toBe(true)
    if (!existsSync(fileURLToPath(newProjectUrl))) return
    const newProject = source("./new/page.tsx")
    const projects = source("./projects/page.tsx")

    expect(newProject).toContain("<main")
    expect(newProject).toContain("buttonVariants({ variant: 'ghost' })")
    expect(newProject).toContain("<NewProjectFlow")
    expect(projects).toContain('href="/new"')
  })

  test("stages source selection, exact-name confirmation, deployment logs, and completion links", () => {
    const flowUrl = new URL("../components/new-project-flow.tsx", import.meta.url)
    expect(existsSync(fileURLToPath(flowUrl))).toBe(true)
    if (!existsSync(fileURLToPath(flowUrl))) return
    const forms = source("../components/new-project-flow.tsx")

    expect(forms).toContain("inferProjectSlugFromGitUrl")
    expect(forms.indexOf("Git repository URL")).toBeLessThan(forms.indexOf("Project name"))
    expect(forms).toContain("PROJECT_SLUG_PATTERN")
    expect(forms).toContain("data-invalid")
    expect(forms).toContain("aria-invalid")
    expect(forms).toContain("<FieldGroup")
    expect(forms).toContain("<Field")
    expect(forms).toContain("<Input")
    expect(forms).toContain("<Spinner")
    expect(forms).toContain("name-availability")
    expect(forms).toContain("/source-preflights")
    expect(forms).toContain("Checking Eve compatibility")
    expect(forms).toContain("preflightId")
    expect(forms).toContain("Environment variables")
    expect(forms).toContain("<Collapsible")
    expect(forms).toContain("<Table")
    expect(forms).toContain("<Dialog")
    expect(forms).toContain("environmentVariables")
    expect(forms).toContain("Add variable")
    expect(forms).toContain("Edit variable")
    expect(forms).toContain("Remove variable")
    expect(forms).toContain('type={environmentDraft.visible ? "text" : "password"}')
    expect(forms).toContain("event.stopPropagation()")
    expect(forms).toContain("deployAfterImport")
    expect(forms).toContain("getNewProjectProgress")
    expect(forms).toContain("navigator.clipboard.writeText")
    expect(forms).toContain("Deployment logs")
    expect(forms).toContain("View project")
    expect(forms).toContain("Could not reach the Eveland API.")
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

  test("renders Playground as a fresh AI Elements conversation", () => {
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
    expect(playground).toContain('agent.status === "submitted"')
    expect(playground).toContain("Starting agent and sending your message")
    expect(nextConfig).toContain('source: "/api/eveland/:path*"')
  })

  test("keeps the Playground Agent Connection dialog scrollable within the viewport", () => {
    const connectionSettings = source("../components/agent-connection-settings.tsx")

    expect(connectionSettings).toContain("max-h-[calc(100svh-2rem)]")
    expect(connectionSettings).toContain("overflow-y-auto")
  })

  test("shows the deployed Eve version across project, source, and Playground surfaces", () => {
    const projectOverview = source("./projects/[projectId]/page.tsx")
    const sourcePage = source("./projects/[projectId]/source/page.tsx")
    const playgroundPage = source("./projects/[projectId]/playground/page.tsx")
    const playground = source("../components/playground-panel.tsx")
    const serverApi = source("../lib/server-api.ts")

    expect(serverApi).toContain("export const getEveVersion")
    expect(projectOverview).toContain("getEveVersion(projectId)")
    expect(projectOverview).toContain('["Eve Agent", eveVersion.version')
    expect(sourcePage).toContain("getEveVersion(projectId)")
    expect(sourcePage).toContain("requires {eveVersion.expected}")
    expect(playgroundPage).toContain("getEveVersion(projectId)")
    expect(playgroundPage).toContain("eveVersion={eveVersion}")
    expect(playground).toContain("Eve upgrade required")
    expect(playground).toContain("Upgrade the project's eve dependency")
  })

  test("renders session replay as a chat conversation with a raw event toggle", () => {
    const page = source("./projects/[projectId]/sessions/[sessionId]/page.tsx")
    const replay = source("../components/session-replay.tsx")

    expect(page).toContain("<SessionReplay")
    expect(replay).toContain("buildSessionTranscript")
    expect(replay).toContain("<MessageResponse")
    expect(replay).toContain("<Reasoning")
    expect(replay).toContain("<Tool")
    expect(replay).toContain("<ToolHeader")
    expect(replay).toContain('setView("raw")')
    expect(replay).toContain("<RawView")
  })
})
