import { MockLanguageModelV3 } from "ai/test";

type GenerateOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

/**
 * The tool each test Connection exposes, by Connection name. Since eve 0.69
 * the model never sees a discovered tool in its tool list: it finds it with a
 * search tool and calls it through an execute tool. Through eve 0.75 those
 * are `connection_search({ connection, query })` and
 * `connection_execute({ connection, tool, input })`, naming the tool by its
 * own (unqualified) name; from 0.76 they are eve's catalog tools
 * `eve__search({ query })` and `eve__tool({ name, input })`, and every
 * connection tool is named `<connection>__<tool>`. The model reads which
 * generation it is on from the tool list it is offered.
 */
const CONNECTION_TOOLS = {
  warehouse: "getConnectionStatus",
  knowledge: "lookupConnectionRecord",
  research: "lookupConnectionRecord",
} as const;

type ConnectionName = keyof typeof CONNECTION_TOOLS;

/** The search/execute pair a generation offers, or null when neither is listed. */
function catalogTools(toolNames: readonly string[]): {
  search: string;
  execute: string;
  qualified: boolean;
} | null {
  if (toolNames.includes("eve__search") && toolNames.includes("eve__tool")) {
    return { search: "eve__search", execute: "eve__tool", qualified: true };
  }
  if (toolNames.includes("connection_search")) {
    return { search: "connection_search", execute: "connection_execute", qualified: false };
  }
  return null;
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
    const connection: ConnectionName = userPrompt.includes('connection \\"warehouse\\"')
      ? "warehouse"
      : userPrompt.includes('connection \\"research\\"')
        ? "research"
        : "knowledge";
    const catalog = catalogTools(toolNames);
    const tool = CONNECTION_TOOLS[connection];
    const qualifiedTool = `${connection}__${tool}`;

    // A Connection call or a delegation came back: the flow is done. On eve
    // 0.69 a delegation first answers with its task receipt; the turn then
    // holds for the child and calls the model again with its result, which
    // falls through to the same closing text below.
    if (
      ["connection_execute", "eve__tool", qualifiedTool, "researcher", "agent"].some(lastToolResult)
    ) {
      return textResult("managed Connection flow complete");
    }

    if (catalog !== null && lastToolResult(catalog.search)) {
      // A failed discovery must terminate instead of asking for the same tool
      // forever; the integration assertions will report the missing HTTP call.
      if (!lastMessage.includes(catalog.qualified ? qualifiedTool : tool)) {
        return textResult("managed Connection discovery failed");
      }
      return toolCallResult(
        catalog.execute,
        catalog.qualified ? { name: qualifiedTool, input: {} } : { connection, tool, input: {} },
      );
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

    if (catalog !== null && /Search connection/u.test(userPrompt)) {
      const query = connection === "warehouse" ? "connection status" : "connection record";
      return toolCallResult(
        catalog.search,
        // A `<connection>__` prefix searches only that connection's tools.
        catalog.qualified ? { query: `${connection}__ ${query}` } : { connection, query },
      );
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
