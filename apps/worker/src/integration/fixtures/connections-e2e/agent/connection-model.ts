import { MockLanguageModelV3 } from "ai/test";

type GenerateOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

const QUALIFIED_CONNECTION_TOOLS = [
  "warehouse__getConnectionStatus",
  "knowledge__lookupConnectionRecord",
  "research__lookupConnectionRecord",
] as const;

export function connectionTestModel(): MockLanguageModelV3 {
  const generate = (options: GenerateOptions): GenerateResult => {
    const userPrompt = JSON.stringify(
      [...options.prompt].reverse().find((message) => message.role === "user"),
    );
    const lastMessage = JSON.stringify(options.prompt.at(-1));
    const toolNames = (options.tools ?? []).flatMap((tool) =>
      tool.type === "function" ? [tool.name] : [],
    );

    if (
      lastMessage.includes('"type":"tool-result"') &&
      [...QUALIFIED_CONNECTION_TOOLS, "researcher", "agent"].some((toolName) =>
        lastMessage.includes(`"toolName":"${toolName}"`),
      )
    ) {
      return textResult("managed Connection flow complete");
    }

    for (const toolName of QUALIFIED_CONNECTION_TOOLS) {
      if (toolNames.includes(toolName) && userPrompt.includes(toolName.split("__")[0]!)) {
        return toolCallResult(toolName, {});
      }
    }

    // A failed discovery must terminate instead of asking for the same tool
    // forever; the integration assertions will report the missing HTTP call.
    if (
      lastMessage.includes('"type":"tool-result"') &&
      lastMessage.includes('"toolName":"connection_search"')
    ) {
      return textResult("managed Connection discovery failed");
    }

    if (
      (toolNames.includes("researcher") || toolNames.includes("agent")) &&
      /delegate\s+to\s+a\s+subagent\s*:/iu.test(userPrompt)
    ) {
      return toolCallResult(toolNames.includes("researcher") ? "researcher" : "agent", {
        message:
          'Use connection_search with connection "research" and keywords "connection record", then call research__lookupConnectionRecord.',
      });
    }

    if (toolNames.includes("connection_search") && userPrompt.includes("connection_search")) {
      const connection = userPrompt.includes('connection \\"warehouse\\"')
        ? "warehouse"
        : userPrompt.includes('connection \\"research\\"')
          ? "research"
          : "knowledge";
      return toolCallResult("connection_search", {
        connection,
        keywords: connection === "warehouse" ? "connection status" : "connection record",
      });
    }

    return textResult("managed Connection flow complete");
  };

  return new MockLanguageModelV3({
    provider: "eveland-connections-e2e",
    modelId: "eveland-connections-e2e",
    doGenerate: async (options) => generate(options),
    doStream: async (options) => streamResult(generate(options)),
  });
}

function toolCallResult(toolName: string, input: Record<string, unknown>): GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `call_${toolName.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { raw: undefined, unified: "tool-calls" },
    usage: usage(),
    warnings: [],
  };
}

function textResult(text: string): GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { raw: undefined, unified: "stop" },
    usage: usage(),
    warnings: [],
  };
}

function usage(): GenerateResult["usage"] {
  return {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
    outputTokens: { reasoning: 0, text: 5, total: 5 },
  };
}

function streamResult(
  result: GenerateResult,
): Awaited<ReturnType<MockLanguageModelV3["doStream"]>> {
  const chunks: Array<unknown> = [{ type: "stream-start", warnings: result.warnings }];
  let textIndex = 0;
  for (const content of result.content) {
    if (content.type === "text") {
      const id = `text_${textIndex++}`;
      chunks.push({ type: "text-start", id });
      if (content.text) chunks.push({ type: "text-delta", id, delta: content.text });
      chunks.push({ type: "text-end", id });
    } else if (content.type === "tool-call") {
      chunks.push(content);
    }
  }
  chunks.push({ type: "finish", finishReason: result.finishReason, usage: result.usage });
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  } as Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
}
