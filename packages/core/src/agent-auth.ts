import { z } from "zod";

export const AGENT_AUTH_ENVELOPE_HEADER = "x-eveland-agent-auth";

export type AgentAuthAuthority = "loopback" | "canonical";
export type AgentCredentialHeader = readonly [name: string, value: string];

export type AgentAuthEnvelope = {
  version: 1;
  authority: AgentAuthAuthority;
  headers: AgentCredentialHeader[];
};

export type AgentAuthMethodFieldDescriptor = {
  key: string;
  label: string;
  input: "text" | "password" | "textarea" | "select";
  required: boolean;
  secret: boolean;
  valueType: "string" | "string-list" | "json-record";
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
};

export type AgentAuthMethodDescriptor = {
  method: string;
  label: string;
  description: string;
  credentialScope: "connection" | "principal";
  interactive: boolean;
  fields: AgentAuthMethodFieldDescriptor[];
};

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

const credentialHeaderSchema = z.tuple([
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

const credentialHeadersSchema = z.array(credentialHeaderSchema).max(32).superRefine((headers, context) => {
  const seen = new Set<string>();
  for (const [index, [name]] of headers.entries()) {
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      context.addIssue({ code: "custom", path: [index, 0], message: `Duplicate Agent credential header ${normalized}.` });
    }
    seen.add(normalized);
  }
});

const envelopeSchema = z.object({
  version: z.literal(1),
  authority: z.enum(["loopback", "canonical"]),
  headers: credentialHeadersSchema,
}).strict();

export function parseAgentCredentialHeaders(input: unknown): AgentCredentialHeader[] {
  return credentialHeadersSchema.parse(input);
}

export function encodeAgentAuthEnvelope(envelope: AgentAuthEnvelope): string {
  const json = JSON.stringify(envelopeSchema.parse(envelope));
  return encodeBase64Url(new TextEncoder().encode(json));
}

export function decodeAgentAuthEnvelope(value: string): AgentAuthEnvelope {
  const json = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value));
  return envelopeSchema.parse(JSON.parse(json));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error("Invalid base64url value.");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
