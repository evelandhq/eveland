import { MockLanguageModelV3 } from "ai/test";

type GenerateOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

/** A deterministic model that makes exactly one durable sleep tool call. */
export function wakeTestModel(): MockLanguageModelV3 {
  const generate = (options: GenerateOptions): GenerateResult => {
    const lastMessage = JSON.stringify(options.prompt.at(-1));
    if (
      lastMessage.includes('"type":"tool-result"') &&
      lastMessage.includes('"toolName":"sleep"')
    ) {
      return textResult("awake");
    }

    const userPrompt = JSON.stringify(
      [...options.prompt].reverse().find((message) => message.role === "user"),
    );
    const seconds = Number(/sleep-seconds:(\d+)/u.exec(userPrompt)?.[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return textResult("missing sleep duration");
    }
    return toolCallResult("sleep", { seconds });
  };

  return new MockLanguageModelV3({
    provider: "eveland-workflow-wake-e2e",
    modelId: "eveland-workflow-wake-e2e",
    doGenerate: async (options) => generate(options),
    doStream: async (options) => streamResult(generate(options)),
  });
}

function toolCallResult(toolName: string, input: Record<string, unknown>): GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: "call_sleep_once",
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
      const id = `text_${String(textIndex++)}`;
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
