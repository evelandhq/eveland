import { notFound } from "next/navigation"
import { ProjectDangerZone } from "@/components/project-danger-zone"
import { ProjectGeneralSettings } from "@/components/project-general-settings"
import { Separator } from "@/components/ui/separator"
import { getProject } from "@/lib/server-api"

export const dynamic = "force-dynamic"
export const metadata = {
  title: "General settings",
}

export default async function ProjectGeneralSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const project = await getProject(projectId)
  if (!project) notFound()

  return (
    <div className="flex flex-col gap-9">
      <section aria-labelledby="project-details-heading">
        <h3 id="project-details-heading" className="font-medium">
          Project details
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Display metadata can change; the slug and Project ID remain stable.
        </p>
        <div className="mt-5">
          <ProjectGeneralSettings project={project} />
        </div>
      </section>
      <Separator />
      <ProjectDangerZone project={project} />
    </div>
  )
}
