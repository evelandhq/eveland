import { MockLanguageModelV3 } from "ai/test";

type GenerateOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

/**
 * The tool each test Connection exposes, by Connection name. The model never
 * sees a discovered tool in its tool list: it finds it with eve's catalog
 * search tool `eve__search({ query })` and calls it through
 * `eve__tool({ name, input })`, and every connection tool is named
 * `<connection>__<tool>`.
 */
const CONNECTION_TOOLS = {
  warehouse: "getConnectionStatus",
  knowledge: "lookupConnectionRecord",
  research: "lookupConnectionRecord",
  signin: "getSigninStatus",
} as const;

const CONNECTION_QUERIES: Record<ConnectionName, string> = {
  warehouse: "connection status",
  knowledge: "connection record",
  research: "connection record",
  signin: "signin status",
};

type ConnectionName = keyof typeof CONNECTION_TOOLS;

function connectionNamed(userPrompt: string): ConnectionName {
  for (const name of Object.keys(CONNECTION_TOOLS) as ConnectionName[]) {
    if (userPrompt.includes(`connection \\"${name}\\"`)) return name;
  }
  return "knowledge";
}

export function connectionTestModel(): MockLanguageModelV3 {
  const generate = (options: GenerateOptions): GenerateResult => {
    const userPrompt = JSON.stringify(
      [...options.prompt].reverse().find((message) => message.role === "user"),
    );
    const lastMessage = JSON.stringify(options.prompt.at(-1));
    const toolNames = (options.tools ?? []).flatMap((tool) =>
      tool.type === "function" ? [tool.name] : [],
    );
    const lastToolResult = (toolName: string) =>
      lastMessage.includes('"type":"tool-result"') &&
      lastMessage.includes(`"toolName":"${toolName}"`);
    const connection = connectionNamed(userPrompt);
    const catalog = toolNames.includes("eve__search") && toolNames.includes("eve__tool");
    const qualifiedTool = `${connection}__${CONNECTION_TOOLS[connection]}`;

    // A Connection call or a delegation came back: the flow is done. A
    // delegation first answers with its task receipt; the turn then
    // holds for the child and calls the model again with its result, which
    // falls through to the same closing text below.
    if (["eve__tool", qualifiedTool, "researcher", "remote", "agent"].some(lastToolResult)) {
      return textResult("managed Connection flow complete");
    }

    if (catalog && lastToolResult("eve__search")) {
      // A failed discovery must terminate instead of asking for the same tool
      // forever; the integration assertions will report the missing HTTP call.
      if (!lastMessage.includes(qualifiedTool)) {
        return textResult("managed Connection discovery failed");
      }
      return toolCallResult("eve__tool", { name: qualifiedTool, input: {} });
    }

    // Memory: `Remember: <fact>` saves through the `file` memory slot's tool;
    // `What do you remember?` answers with the fact eve recalled into the
    // prompt from the saved document, or says nothing was recalled.
    if (lastToolResult("file__save_memory")) return textResult("memory saved");
    const remember = /Remember:\s*(memory fact [a-z0-9-]+)/u.exec(userPrompt)?.[1];
    if (remember && toolNames.includes("file__save_memory")) {
      return toolCallResult("file__save_memory", { text: remember });
    }
    if (userPrompt.includes("What do you remember?")) {
      const recalled = /\d+: (memory fact [a-z0-9-]+)/u.exec(JSON.stringify(options.prompt))?.[1];
      return textResult(recalled ? `I remember ${recalled}` : "I remember nothing");
    }

    if (toolNames.includes("remote") && /ask\s+the\s+remote\s+agent\s*:/iu.test(userPrompt)) {
      return toolCallResult("remote", { message: "Report the remote status." });
    }

    if (
      (toolNames.includes("researcher") || toolNames.includes("agent")) &&
      /delegate\s+to\s+a\s+subagent\s*:/iu.test(userPrompt)
    ) {
      return toolCallResult(toolNames.includes("researcher") ? "researcher" : "agent", {
        message:
          'Search connection "research" for "connection record", then call lookupConnectionRecord.',
      });
    }

    if (catalog && /Search connection/u.test(userPrompt)) {
      // A `<connection>__` prefix searches only that connection's tools.
      return toolCallResult("eve__search", {
        query: `${connection}__ ${CONNECTION_QUERIES[connection]}`,
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
