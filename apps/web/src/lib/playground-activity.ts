import type { EveMessage, EveMessagePart } from "eve/react"

type VisiblePlaygroundPart = Extract<EveMessagePart, { type: "text" | "file" }>
export type PlaygroundActivityPart = Extract<EveMessagePart, { type: "reasoning" | "dynamic-tool" | "authorization" }>

export type PlaygroundDisplayItem =
  | { kind: "part"; part: VisiblePlaygroundPart }
  | {
      kind: "activity"
      status: "completed" | "failed" | "cancelled" | "running"
      parts: PlaygroundActivityPart[]
    }

export function groupPlaygroundParts(
  parts: readonly EveMessagePart[],
  messageStatus: NonNullable<EveMessage["metadata"]>["status"],
): PlaygroundDisplayItem[] {
  const displayItems: PlaygroundDisplayItem[] = []
  let activityParts: PlaygroundActivityPart[] = []

  const flushActivity = (trailing = false) => {
    if (activityParts.length === 0) return
    displayItems.push({
      kind: "activity",
      status: playgroundActivityStatus(activityParts, messageStatus, trailing),
      parts: activityParts,
    })
    activityParts = []
  }

  for (const current of parts) {
    if (current.type === "step-start") continue
    if (current.type === "text" || current.type === "file") {
      flushActivity()
      displayItems.push({ kind: "part", part: current })
    } else {
      activityParts.push(current)
    }
  }
  flushActivity(true)

  return displayItems
}

function playgroundActivityStatus(
  parts: PlaygroundActivityPart[],
  messageStatus: NonNullable<EveMessage["metadata"]>["status"],
  trailing: boolean,
): Extract<PlaygroundDisplayItem, { kind: "activity" }>["status"] {
  if (
    parts.some(
      (part) =>
        (part.type === "dynamic-tool" && part.state === "output-error") ||
        (part.type === "authorization" && part.state === "completed" && part.outcome === "failed"),
    ) ||
    (trailing && messageStatus === "failed")
  ) {
    return "failed"
  }
  if (
    parts.some(
      (part) =>
        (part.type === "dynamic-tool" && part.state === "output-denied") ||
        (part.type === "authorization" &&
          part.state === "completed" &&
          (part.outcome === "declined" || part.outcome === "timed-out")),
    )
  ) {
    return "cancelled"
  }
  if (
    parts.some(
      (part) =>
        (part.type === "reasoning" && part.state === "streaming") ||
        (part.type === "authorization" && part.state === "required") ||
        (part.type === "dynamic-tool" &&
          part.state !== "output-available" &&
          part.state !== "output-error" &&
          part.state !== "output-denied"),
    ) ||
    (trailing && (messageStatus === "streaming" || messageStatus === "submitted"))
  ) {
    return "running"
  }
  return "completed"
}
