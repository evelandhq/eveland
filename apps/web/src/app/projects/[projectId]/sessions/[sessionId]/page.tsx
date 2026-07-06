import { getSessionEvents } from "@/lib/api"

export default async function SessionTimelinePage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>
}) {
  const { sessionId } = await params
  const events = await getSessionEvents(sessionId)

  return (
    <section className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Session timeline</h2>
        <p className="mt-1 text-xs text-muted-foreground">{sessionId}</p>
      </div>
      {events.length === 0 ? (
        <div className="flex min-h-80 items-center justify-center px-4 text-sm text-muted-foreground">No timeline events recorded.</div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {events.map((event) => (
            <article key={event.id} className="rounded-md border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-xs font-semibold uppercase tracking-normal">{event.type}</h3>
                <time className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</time>
              </div>
              <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-3 text-xs leading-5">{formatPayload(event.payload)}</pre>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload
  }
  if (isRecord(payload)) {
    const content = payload.content
    if (typeof content === "string") {
      return content
    }
    const message = payload.message
    if (typeof message === "string") {
      return message
    }
  }
  return JSON.stringify(payload, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
