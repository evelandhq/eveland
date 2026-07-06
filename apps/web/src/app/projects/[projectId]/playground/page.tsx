import { PlaygroundPanel } from "@/components/playground-panel"

type PlaygroundPageProps = {
  params: Promise<{ projectId: string }>
}

export default async function PlaygroundPage({ params }: PlaygroundPageProps) {
  const { projectId } = await params
  return <PlaygroundPanel projectId={projectId} />
}
