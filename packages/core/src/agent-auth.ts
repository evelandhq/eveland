import { z } from "zod";

export const AGENT_AUTH_ENVELOPE_HEADER = "x-eveland-agent-auth";

const reservedCredentialHeaders = new Set([
  "connection",
  "content-length",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const agentCredentialHeaderSchema = z.tuple([
  z.string().min(1).max(256),
  z.string().max(16_384),
]).superRefine(([name, value], context) => {
  const normalized = name.toLowerCase();
  if (
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
    || reservedCredentialHeaders.has(normalized)
    || normalized.startsWith("proxy-")
    || normalized.startsWith("x-forwarded-")
    || normalized.startsWith("x-eveland-")
    || /[\u0000-\u0008\u000A-\u001F\u007F]/.test(value)
  ) {
    context.addIssue({ code: "custom", message: `Agent credential header ${normalized} is not allowed.` });
  }
});

const agentAuthEnvelopeSchema = z.object({
  version: z.literal(1),
  authority: z.enum(["loopback", "canonical"]),
  headers: z.array(agentCredentialHeaderSchema).max(32),
}).strict();

export type AgentAuthEnvelope = z.infer<typeof agentAuthEnvelopeSchema>;

export type AgentAuthMethodFieldDescriptor = {
  key: string;
  label: string;
  input: "text" | "password" | "textarea";
  required: boolean;
  secret: boolean;
  valueType: "string" | "string-list" | "json-record";
};

export type AgentAuthMethodDescriptor = {
  method: string;
  label: string;
  description: string;
  credentialScope: "connection" | "principal";
  interactive: boolean;
  fields: AgentAuthMethodFieldDescriptor[];
};

export function encodeAgentAuthEnvelope(envelope: AgentAuthEnvelope): string {
  return Buffer.from(JSON.stringify(agentAuthEnvelopeSchema.parse(envelope)), "utf8").toString("base64url");
}

export function decodeAgentAuthEnvelope(value: string): AgentAuthEnvelope {
  return agentAuthEnvelopeSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
}
