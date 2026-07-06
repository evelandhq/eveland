"use client"

import { useMemo, useState } from "react"
import { LoaderCircleIcon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { runPlaygroundMessage, type Session, type SessionEvent } from "@/lib/api"

type PlaygroundPanelProps = {
  projectId: string
}

export function PlaygroundPanel({ projectId }: PlaygroundPanelProps) {
  const [message, setMessage] = useState("")
  const [session, setSession] = useState<Session | null>(null)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = message.trim()
    if (!trimmed || isPending) {
      return
    }

    setIsPending(true)
    setError(null)
    try {
      const result = await runPlaygroundMessage(projectId, trimmed)
      setSession(result.session)
      setEvents(result.events)
      setMessage("")
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError))
    } finally {
      setIsPending(false)
    }
  }

  const toolCallCount = useMemo(() => events.filter((event) => event.type === "tool_call").length, [events])

  return (
    <div className="grid min-h-[calc(100vh-9rem)] gap-4 lg:grid-cols-[1fr_22rem]">
      <section className="flex flex-col rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Playground</h2>
          <p className="mt-1 text-xs text-muted-foreground">{session?.id ?? "Idle"}</p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4">
          {events.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No active conversation.</div>
          ) : (
            events.map((event) => <TimelineEvent key={event.id} event={event} />)
          )}
        </div>
        <form className="border-t border-border p-3" onSubmit={submitMessage}>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="playground-message" className="sr-only">
                Message
              </FieldLabel>
              <div className="flex items-end gap-2">
                <Textarea
                  id="playground-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={isPending}
                  aria-invalid={Boolean(error)}
                  className="min-h-20 flex-1"
                  placeholder="Ask the deployed agent..."
                />
                <Button type="submit" disabled={isPending || message.trim().length === 0}>
                  {isPending ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
                  Send
                </Button>
              </div>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          </FieldGroup>
        </form>
      </section>
      <aside className="rounded-md border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Current session</h3>
        <dl className="mt-4 flex flex-col gap-3 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Trigger</dt>
            <dd>{session?.trigger ?? "playground"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Tool calls</dt>
            <dd>{toolCallCount}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">State</dt>
            <dd>{session?.status ?? (isPending ? "running" : "idle")}</dd>
          </div>
          {session ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Session</dt>
              <dd className="truncate text-right">{session.id}</dd>
            </div>
          ) : null}
        </dl>
      </aside>
    </div>
  )
}

function TimelineEvent({ event }: { event: SessionEvent }) {
  return (
    <article className="rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-xs font-semibold uppercase tracking-normal">{event.type}</h3>
        <time className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</time>
      </div>
      <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted p-3 text-xs leading-5">{formatPayload(event.payload)}</pre>
    </article>
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
