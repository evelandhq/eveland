import { z } from "zod";
import {
  observabilityPolicySchema,
  type ObservabilityPolicy,
} from "@eveland/core/observability/policy";

export const AGENT_RUNTIME_POLICY_PATH = "/run/eveland/observability/agent-policy.json";

const agentOtlpEndpointSchema = z.url().superRefine((endpoint, context) => {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "Agent OTLP endpoint must use HTTP or HTTPS.",
    });
  }
  if (parsed.username || parsed.password) {
    context.addIssue({
      code: "custom",
      message: "Agent OTLP endpoint must not contain credentials.",
    });
  }
});

export const agentRuntimePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    capture: z
      .object({
        enabled: z.boolean(),
        sampleRatio: z.number().min(0).max(1),
        recordInputs: z.boolean(),
        recordOutputs: z.boolean(),
      })
      .strict(),
    otlp: z
      .object({
        endpoint: agentOtlpEndpointSchema,
      })
      .strict(),
    deploymentCredential: z.string().min(1),
    resource: z
      .object({
        teamId: z.string().min(1),
        projectId: z.string().min(1),
        releaseId: z.string().min(1),
        deploymentId: z.string().min(1),
        runtimeKind: z.enum(["docker", "systemd"]),
        environment: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const agentEventObservationSchema = z
  .object({
    telemetryEventId: z.string().min(1),
    eventFingerprint: z.string().min(1),
    deploymentId: z.string().min(1),
    runtimeInstanceId: z.string().min(1).nullable().optional(),
    eveSessionId: z.string().min(1),
    parentEveSessionId: z.string().min(1).nullable(),
    sourceSequence: z.number().int().nonnegative().nullable(),
    agent: z
      .object({
        id: z.string().nullable(),
        name: z.string().nullable(),
        nodeId: z.string().nullable(),
      })
      .strict(),
    channelKind: z.string().nullable(),
    eventAt: z.iso.datetime(),
    event: z.unknown(),
  })
  .strict();

export type AgentRuntimePolicy = z.infer<typeof agentRuntimePolicySchema>;
export type AgentEventObservation = z.infer<typeof agentEventObservationSchema>;

export class UnmanagedTelemetryResourceError extends Error {
  readonly code = "UNMANAGED_TELEMETRY_RESOURCE";

  constructor(message: string) {
    super(message);
    this.name = "UnmanagedTelemetryResourceError";
  }
}

export function createAgentRuntimePolicy(input: {
  policy: ObservabilityPolicy;
  otlpEndpoint: string;
  deploymentCredential: string;
  resource: AgentRuntimePolicy["resource"];
}): AgentRuntimePolicy {
  const policy = observabilityPolicySchema.parse(input.policy);
  return agentRuntimePolicySchema.parse({
    schemaVersion: 1,
    revision: policy.revision,
    capture: {
      enabled: policy.agentCapture.enabled,
      sampleRatio: policy.agentCapture.sampling.ratio,
      recordInputs: policy.agentCapture.recordInputs,
      recordOutputs: policy.agentCapture.recordOutputs,
    },
    otlp: {
      endpoint: input.otlpEndpoint,
    },
    deploymentCredential: input.deploymentCredential,
    resource: input.resource,
  });
}
