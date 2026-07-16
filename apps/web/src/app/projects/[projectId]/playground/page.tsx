import { PlaygroundPanel } from "@/components/playground-panel"
import { getEveVersion } from "@/lib/server-api"

type PlaygroundPageProps = {
  params: Promise<{ projectId: string }>
}

export default async function PlaygroundPage({ params }: PlaygroundPageProps) {
  const { projectId } = await params
  const eveVersion = await getEveVersion(projectId)
  return <PlaygroundPanel eveVersion={eveVersion} projectId={projectId} />
}
