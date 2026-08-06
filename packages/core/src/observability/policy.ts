import { z } from "zod";
import {
  externalObservabilityDestinationSchema,
  type ExternalDestinationHealth,
  type ExternalObservabilityDestination,
  type PublicExternalDestinationConfig,
} from "@evelandhq/core/observability/destinations";

export const BUILT_IN_OBSERVABILITY_RETENTION_DAYS = {
  sessions: 90,
  capacity: 30,
} as const;

/**
 * Batch receipts only guard against the Collector redelivering from its persistent
 * queue, so they expire far sooner than the read models. A day covers any realistic
 * API outage; beyond that a redelivered batch is preferable to unbounded receipts.
 */
export const BUILT_IN_BATCH_RECEIPT_RETENTION_HOURS = 24;

export const agentCapturePolicySchema = z
  .object({
    enabled: z.boolean(),
    sampling: z
      .object({
        ratio: z.number().min(0).max(1),
      })
      .strict(),
    recordInputs: z.boolean(),
    /** Covers assistant text, reasoning, and tool results alike. */
    recordOutputs: z.boolean(),
  })
  .strict();

export const observabilityPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    agentCapture: agentCapturePolicySchema,
    externalDestinations: z.array(externalObservabilityDestinationSchema),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = policy.externalDestinations.map((destination) => destination.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["externalDestinations"],
        message: "External destination ids must be unique.",
      });
    }
  });

export type AgentCapturePolicy = z.infer<typeof agentCapturePolicySchema>;
export type ObservabilityPolicy = z.infer<typeof observabilityPolicySchema>;

export type PublicExternalObservabilityDestination<Destination = ExternalObservabilityDestination> =
  Destination extends ExternalObservabilityDestination
    ? Omit<Destination, "encryptedConfig"> & {
        /** Null when the stored configuration cannot be decrypted or no longer validates. */
        config: PublicExternalDestinationConfig | null;
        health: ExternalDestinationHealth;
      }
    : never;

export type PublicObservabilityPolicy = {
  revision: number;
  agentCapture: AgentCapturePolicy;
  externalDestinations: PublicExternalObservabilityDestination[];
};

export function createDefaultObservabilityPolicy(revision: number): ObservabilityPolicy {
  return observabilityPolicySchema.parse({
    schemaVersion: 1,
    revision,
    agentCapture: {
      enabled: true,
      sampling: { ratio: 1 },
      recordInputs: true,
      recordOutputs: true,
    },
    externalDestinations: [],
  });
}

export function toPublicObservabilityPolicy(
  policy: ObservabilityPolicy,
  input: {
    destinationHealth?: ExternalDestinationHealth[];
    /** Decrypted, credential-stripped configuration by destination id. */
    destinationConfigs?: ReadonlyMap<string, PublicExternalDestinationConfig>;
  } = {},
): PublicObservabilityPolicy {
  const healthByDestination = new Map(
    (input.destinationHealth ?? []).map((health) => [health.destinationId, health]),
  );
  return {
    revision: policy.revision,
    agentCapture: policy.agentCapture,
    externalDestinations: policy.externalDestinations.map((destination) => {
      const { encryptedConfig: _encryptedConfig, ...publicDestination } = destination;
      return {
        ...publicDestination,
        config: input.destinationConfigs?.get(destination.id) ?? null,
        health:
          healthByDestination.get(destination.id) ??
          ({
            destinationId: destination.id,
            status: destination.enabled ? "pending" : "paused",
            checkedAt: null,
            lastSuccessAt: null,
            lastError: null,
          } satisfies ExternalDestinationHealth),
      } as PublicExternalObservabilityDestination;
    }),
  };
}
