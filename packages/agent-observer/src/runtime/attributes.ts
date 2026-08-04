import type { Attributes } from "@opentelemetry/api";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_SESSION_ID,
} from "@opentelemetry/semantic-conventions/incubating";
import type { AgentTelemetryHookContext } from "./contracts.js";
import { asString } from "./values.js";

export function commonAttributes(
  sessionId: string,
  turnId: string | undefined,
  context: AgentTelemetryHookContext,
  attributes: Attributes,
): Attributes {
  const agentName = asString(context.agent?.name);
  const agentNodeId = asString(context.agent?.nodeId);
  const channelKind = asString(context.channel?.kind);
  return {
    ...attributes,
    [ATTR_GEN_AI_CONVERSATION_ID]: sessionId,
    [ATTR_SESSION_ID]: sessionId,
    "eveland.eve.session.id": sessionId,
    ...(turnId ? { "eveland.eve.turn.id": turnId } : {}),
    ...(agentName
      ? {
          [ATTR_GEN_AI_AGENT_NAME]: agentName,
          "eveland.eve.agent.name": agentName,
        }
      : {}),
    ...(agentNodeId ? { "eveland.eve.agent.node.id": agentNodeId } : {}),
    ...(channelKind ? { "eveland.eve.channel.kind": channelKind } : {}),
  };
}
