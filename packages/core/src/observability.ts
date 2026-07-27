import { z } from "zod";

export const OBSERVABILITY_SIGNALS = ["traces", "logs", "metrics"] as const;
export const TELEMETRY_DOMAINS = ["agent", "platform", "runtime", "capacity"] as const;
export const EXTERNAL_DESTINATION_KINDS = ["elastic", "langfuse", "custom_otlp"] as const;
export const AGENT_RUNTIME_POLICY_PATH =
  "/run/eveland/observability/agent-policy.json";

export type ObservabilitySignal = (typeof OBSERVABILITY_SIGNALS)[number];
export type TelemetryDomain = (typeof TELEMETRY_DOMAINS)[number];
export type ExternalDestinationKind = (typeof EXTERNAL_DESTINATION_KINDS)[number];

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

export const EXTERNAL_DESTINATION_CAPABILITIES = {
  elastic: {
    signals: OBSERVABILITY_SIGNALS,
    domains: TELEMETRY_DOMAINS,
    filterProfile: "all_eveland",
  },
  langfuse: {
    signals: ["traces"],
    domains: ["agent"],
    filterProfile: "agent_genai",
  },
} as const;

const signalSchema = z.enum(OBSERVABILITY_SIGNALS);
const domainSchema = z.enum(TELEMETRY_DOMAINS);
const destinationBase = {
  id: z.string().min(1),
  enabled: z.boolean(),
  encryptedConfig: z.string().min(1),
  securityRevision: z.number().int().positive(),
};

const allSignalsSchema = z
  .array(signalSchema)
  .length(OBSERVABILITY_SIGNALS.length)
  .superRefine((signals, context) => {
    if (OBSERVABILITY_SIGNALS.some((signal) => !signals.includes(signal))) {
      context.addIssue({
        code: "custom",
        message: "Elastic must receive traces, logs, and metrics.",
      });
    }
  });

const uniqueNonEmptySignalsSchema = z
  .array(signalSchema)
  .min(1)
  .superRefine((signals, context) => {
    if (new Set(signals).size !== signals.length) {
      context.addIssue({
        code: "custom",
        message: "Configured signals must be unique.",
      });
    }
  });

const uniqueNonEmptyDomainsSchema = z
  .array(domainSchema)
  .min(1)
  .superRefine((domains, context) => {
    if (new Set(domains).size !== domains.length) {
      context.addIssue({
        code: "custom",
        message: "Configured telemetry domains must be unique.",
      });
    }
  });

const externalHttpUrlSchema = z.url().superRefine((endpoint, context) => {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "Destination endpoint must use HTTP or HTTPS.",
    });
  }
  if (parsed.username || parsed.password) {
    context.addIssue({
      code: "custom",
      message: "Destination endpoint must not contain credentials.",
    });
  }
});

export function langfuseOtlpTracesEndpoint(baseUrl: string): string {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/api/public/otel/v1/traces`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

const reservedDestinationHeaders = new Set([
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
]);
const destinationHeadersSchema = z
  .record(
    z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    z.string().max(4096),
  )
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase();
      if (
        reservedDestinationHeaders.has(normalized) ||
        normalized.startsWith("x-forwarded-")
      ) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `Header ${name} is reserved and cannot be forwarded.`,
        });
      }
    }
  });

const authorizationTypeSchema = z.enum(["bearer", "api_key"]);
const credentialSchema = z.string().min(1).max(4096);

export const externalDestinationConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("elastic"),
      endpoint: externalHttpUrlSchema,
      authorization: z
        .object({
          type: authorizationTypeSchema,
          value: credentialSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("langfuse"),
      baseUrl: externalHttpUrlSchema,
      publicKey: z.string().min(1).max(1024),
      secretKey: credentialSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom_otlp"),
      endpoint: externalHttpUrlSchema,
      supportedSignals: uniqueNonEmptySignalsSchema,
      domains: uniqueNonEmptyDomainsSchema,
      headers: destinationHeadersSchema,
    })
    .strict(),
]);

/**
 * Submitted configuration. Credential fields are optional because they are never returned
 * to the browser, so an endpoint or filter change cannot require re-typing them;
 * `mergeExternalDestinationConfig` carries the stored credential forward when one is
 * absent, and rejects the payload when there is nothing stored to carry.
 */
export const externalDestinationConfigPatchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("elastic"),
      endpoint: externalHttpUrlSchema,
      authorization: z
        .object({
          type: authorizationTypeSchema,
          value: credentialSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("langfuse"),
      baseUrl: externalHttpUrlSchema,
      publicKey: z.string().min(1).max(1024).optional(),
      secretKey: credentialSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom_otlp"),
      endpoint: externalHttpUrlSchema,
      supportedSignals: uniqueNonEmptySignalsSchema,
      domains: uniqueNonEmptyDomainsSchema,
      headers: destinationHeadersSchema.optional(),
    })
    .strict(),
]);

const elasticDestinationSchema = z
  .object({
    ...destinationBase,
    kind: z.literal("elastic"),
    supportedSignals: allSignalsSchema,
    filterProfile: z.literal("all_eveland"),
  })
  .strict();

const langfuseDestinationSchema = z
  .object({
    ...destinationBase,
    kind: z.literal("langfuse"),
    supportedSignals: z.tuple([z.literal("traces")]),
    filterProfile: z.literal("agent_genai"),
  })
  .strict();

const customOtlpDestinationSchema = z
  .object({
    ...destinationBase,
    kind: z.literal("custom_otlp"),
    supportedSignals: uniqueNonEmptySignalsSchema,
    domains: uniqueNonEmptyDomainsSchema,
    filterProfile: z.literal("custom"),
  })
  .strict();

export const externalObservabilityDestinationSchema = z.discriminatedUnion("kind", [
  elasticDestinationSchema,
  langfuseDestinationSchema,
  customOtlpDestinationSchema,
]);

export const agentCapturePolicySchema = z
  .object({
    enabled: z.boolean(),
    sampling: z
      .object({
        ratio: z.number().min(0).max(1),
      })
      .strict(),
    recordInputs: z.boolean(),
    recordOutputs: z.boolean(),
    includeReasoning: z.boolean(),
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
        includeReasoning: z.boolean(),
      })
      .strict(),
    otlp: z
      .object({
        endpoint: agentOtlpEndpointSchema,
      })
      .strict(),
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

export type ExternalObservabilityDestination = z.infer<
  typeof externalObservabilityDestinationSchema
>;
export type ExternalDestinationConfig = z.infer<
  typeof externalDestinationConfigSchema
>;
export type ExternalDestinationConfigPatch = z.infer<
  typeof externalDestinationConfigPatchSchema
>;
export type AgentCapturePolicy = z.infer<typeof agentCapturePolicySchema>;
export type ObservabilityPolicy = z.infer<typeof observabilityPolicySchema>;
export type AgentRuntimePolicy = z.infer<typeof agentRuntimePolicySchema>;
export type AgentEventObservation = z.infer<
  typeof agentEventObservationSchema
>;
export type OtlpResourceProjection = {
  serviceName: string;
  domain: TelemetryDomain;
  projectId: string | null;
  deploymentId: string | null;
  attributes: Record<string, unknown>;
};
export type OtlpSpanProjection = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  statusCode: number | null;
  statusMessage: string | null;
  scopeName: string | null;
  attributes: Record<string, unknown>;
  resource: OtlpResourceProjection;
  payload: Record<string, unknown>;
};
export type OtlpLogRecordProjection = {
  traceId: string | null;
  spanId: string | null;
  timestamp: string;
  observedTimestamp: string | null;
  severityNumber: number | null;
  severityText: string | null;
  eventName: string | null;
  scopeName: string | null;
  body: unknown;
  attributes: Record<string, unknown>;
  resource: OtlpResourceProjection;
  payload: Record<string, unknown>;
};
export type OtlpMetricDataType =
  | "gauge"
  | "sum"
  | "histogram"
  | "exponential_histogram"
  | "summary";
export type OtlpMetricPointProjection = {
  name: string;
  description: string | null;
  unit: string | null;
  dataType: OtlpMetricDataType;
  aggregationTemporality: number | null;
  monotonic: boolean | null;
  startTimestamp: string | null;
  timestamp: string;
  scopeName: string | null;
  attributes: Record<string, unknown>;
  value: Record<string, unknown>;
  resource: OtlpResourceProjection;
  payload: Record<string, unknown>;
};
export const COLLECTOR_SELF_SERVICE_NAME = "eveland-otel-collector";

/** Collector component id for a destination's exporter, used in rendered pipelines. */
export function collectorExporterComponentId(
  destinationId: string,
): string {
  return `otlp_http/${destinationId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

export type ExternalDestinationHealth = {
  destinationId: string;
  status: "pending" | "healthy" | "degraded" | "paused";
  checkedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export class UnmanagedTelemetryResourceError extends Error {
  readonly code = "UNMANAGED_TELEMETRY_RESOURCE";

  constructor(message: string) {
    super(message);
    this.name = "UnmanagedTelemetryResourceError";
  }
}
/**
 * The configuration an Admin may see again: destination URLs and the non-credential
 * choices around them. Credential values stay behind `encryptedConfig`; only the shape of
 * the credential — its authorization mode, the names of forwarded headers — is public, so
 * the Settings page can show what is configured without being able to read it.
 */
export type PublicExternalDestinationConfig =
  | {
      kind: "elastic";
      endpoint: string;
      authorization: { type: "bearer" | "api_key" };
    }
  | { kind: "langfuse"; baseUrl: string }
  | { kind: "custom_otlp"; endpoint: string; headerNames: string[] };

export function toPublicExternalDestinationConfig(
  config: ExternalDestinationConfig,
): PublicExternalDestinationConfig {
  switch (config.kind) {
    case "elastic":
      return {
        kind: "elastic",
        endpoint: config.endpoint,
        authorization: { type: config.authorization.type },
      };
    case "langfuse":
      return { kind: "langfuse", baseUrl: config.baseUrl };
    case "custom_otlp":
      return {
        kind: "custom_otlp",
        endpoint: config.endpoint,
        headerNames: Object.keys(config.headers).sort(),
      };
  }
}

/**
 * Resolves a submitted patch against the stored configuration. A credential absent from
 * the patch means "keep the stored one", which is the only way an Admin can edit a
 * destination they can no longer read the credential of.
 */
export function mergeExternalDestinationConfig(
  patch: ExternalDestinationConfigPatch,
  previous: ExternalDestinationConfig | null,
): ExternalDestinationConfig {
  switch (patch.kind) {
    case "elastic": {
      const value =
        patch.authorization.value ??
        (previous?.kind === "elastic" ? previous.authorization.value : undefined);
      if (!value) throw new Error("An Elastic credential is required.");
      return externalDestinationConfigSchema.parse({
        ...patch,
        authorization: { type: patch.authorization.type, value },
      });
    }
    case "langfuse": {
      const publicKey =
        patch.publicKey ??
        (previous?.kind === "langfuse" ? previous.publicKey : undefined);
      const secretKey =
        patch.secretKey ??
        (previous?.kind === "langfuse" ? previous.secretKey : undefined);
      if (!publicKey || !secretKey) {
        throw new Error("A Langfuse public key and secret key are required.");
      }
      return externalDestinationConfigSchema.parse({
        ...patch,
        publicKey,
        secretKey,
      });
    }
    case "custom_otlp": {
      const headers =
        patch.headers ??
        (previous?.kind === "custom_otlp" ? previous.headers : undefined);
      if (!headers) throw new Error("Custom OTLP headers are required.");
      return externalDestinationConfigSchema.parse({ ...patch, headers });
    }
  }
}

export type PublicExternalObservabilityDestination<
  Destination = ExternalObservabilityDestination,
> = Destination extends ExternalObservabilityDestination
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
      includeReasoning: true,
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
    (input.destinationHealth ?? []).map((health) => [
      health.destinationId,
      health,
    ]),
  );
  return {
    revision: policy.revision,
    agentCapture: policy.agentCapture,
    externalDestinations: policy.externalDestinations.map((destination) => {
      const { encryptedConfig: _encryptedConfig, ...publicDestination } =
        destination;
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

export function createAgentRuntimePolicy(input: {
  policy: ObservabilityPolicy;
  otlpEndpoint: string;
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
      includeReasoning: policy.agentCapture.includeReasoning,
    },
    otlp: {
      endpoint: input.otlpEndpoint,
    },
    resource: input.resource,
  });
}
