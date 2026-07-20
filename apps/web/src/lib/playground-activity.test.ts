import { describe, expect, test } from "vitest"
import type { EveMessagePart } from "eve/react"
import { groupPlaygroundParts } from "./playground-activity"

const part = (value: EveMessagePart) => value

describe("groupPlaygroundParts", () => {
  test("groups consecutive reasoning and tools before visible text", () => {
    const parts = [
      part({ type: "reasoning", text: "Inspect the repository", state: "done" }),
      part({
        type: "dynamic-tool",
        toolCallId: "call_1",
        toolName: "search",
        input: { query: "SessionReplay" },
        output: "Found",
        state: "output-available",
      }),
      part({ type: "text", text: "Here is what I found.", state: "done" }),
    ]

    expect(groupPlaygroundParts(parts, "complete")).toEqual([
      {
        kind: "activity",
        status: "completed",
        parts: [parts[0], parts[1]],
      },
      { kind: "part", part: parts[2] },
    ])
  })

  test("uses text and files as activity boundaries while ignoring step markers", () => {
    const parts = [
      part({ type: "text", text: "Starting", state: "done" }),
      part({ type: "step-start" }),
      part({ type: "reasoning", text: "Think", state: "done" }),
      part({ type: "file", mediaType: "text/plain", filename: "notes.txt" }),
      part({
        type: "dynamic-tool",
        toolCallId: "call_2",
        toolName: "read_file",
        input: { path: "notes.txt" },
        state: "input-available",
      }),
    ]

    expect(groupPlaygroundParts(parts, "streaming").map((item) => item.kind)).toEqual([
      "part",
      "activity",
      "part",
      "activity",
    ])
    expect(groupPlaygroundParts(parts, "streaming").at(-1)).toMatchObject({ status: "running" })
  })

  test("keeps authorization requests open and surfaces terminal failures", () => {
    const authorization = part({
      type: "authorization",
      state: "required",
      name: "github",
      displayName: "GitHub",
      description: "Connect GitHub",
      stepIndex: 0,
      turnId: "turn_0",
    })
    const failedTool = part({
      type: "dynamic-tool",
      toolCallId: "call_3",
      toolName: "deploy",
      input: {},
      errorText: "Deployment failed",
      state: "output-error",
    })

    expect(groupPlaygroundParts([authorization], "streaming")).toMatchObject([
      { kind: "activity", status: "running" },
    ])
    expect(groupPlaygroundParts([failedTool], "failed")).toMatchObject([
      { kind: "activity", status: "failed" },
    ])
  })
})
