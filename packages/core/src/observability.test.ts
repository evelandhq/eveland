import { describe, expect, test } from "vitest";
import {
  AGENT_RUNTIME_POLICY_PATH,
  BUILT_IN_BATCH_RECEIPT_RETENTION_HOURS,
  BUILT_IN_OBSERVABILITY_RETENTION_DAYS,
  BUILT_IN_DESTINATION_CAPABILITY,
  createAgentRuntimePolicy,
  createDefaultObservabilityPolicy,
  externalDestinationConfigSchema,
  langfuseOtlpTracesEndpoint,
  observabilityPolicySchema,
  toPublicObservabilityPolicy,
  type ObservabilityPolicy,
} from "./observability.js";

describe("observability policy", () => {
  test("defines non-configurable Built-in retention windows", () => {
    expect(BUILT_IN_OBSERVABILITY_RETENTION_DAYS).toEqual({
      sessions: 90,
      capacity: 30,
    });
    // Receipts only have to outlive the Collector's retry window, not the read models.
    expect(BUILT_IN_BATCH_RECEIPT_RETENTION_HOURS).toBe(24);
  });

  test("keeps Built-in mandatory and outside configurable destinations", () => {
    const policy = createDefaultObservabilityPolicy(1);

    expect(BUILT_IN_DESTINATION_CAPABILITY).toEqual({
      configurable: false,
      signals: ["traces", "logs", "metrics"],
      domains: ["agent", "platform", "runtime", "capacity"],
    });
    expect(policy).toEqual({
      schemaVersion: 1,
      revision: 1,
      agentCapture: {
        enabled: true,
        sampling: { ratio: 1 },
        recordInputs: true,
        recordOutputs: true,
        includeReasoning: true,
      },
      externalDestinations: [],
    });
    expect(
      observabilityPolicySchema.safeParse({
        ...policy,
        externalDestinations: [{
          id: "destination_1",
          kind: "built_in",
          enabled: true,
          supportedSignals: ["traces", "logs", "metrics"],
          filterProfile: "all_eveland",
          encryptedConfig: "ciphertext",
          securityRevision: 1,
        }],
      }).success,
    ).toBe(false);
  });

  test("enforces the Elastic and Langfuse capability presets", () => {
    const base = createDefaultObservabilityPolicy(2);
    const elastic = {
      id: "destination_elastic",
      kind: "elastic",
      enabled: true,
      supportedSignals: ["metrics", "traces", "logs"],
      filterProfile: "all_eveland",
      encryptedConfig: "ciphertext",
      securityRevision: 1,
    };
    const langfuse = {
      id: "destination_langfuse",
      kind: "langfuse",
      enabled: true,
      supportedSignals: ["traces"],
      filterProfile: "agent_genai",
      encryptedConfig: "ciphertext",
      securityRevision: 1,
    };

    expect(
      observabilityPolicySchema.safeParse({
        ...base,
        externalDestinations: [elastic, langfuse],
      }).success,
    ).toBe(true);
    expect(
      observabilityPolicySchema.safeParse({
        ...base,
        externalDestinations: [
          {
            ...langfuse,
            supportedSignals: ["traces", "logs"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      observabilityPolicySchema.safeParse({
        ...base,
        externalDestinations: [
          {
            ...elastic,
            supportedSignals: ["traces", "logs"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("allows Custom OTLP to select non-empty signals and domains", () => {
    const policy = createDefaultObservabilityPolicy(3);
    const custom = {
      id: "destination_custom",
      kind: "custom_otlp",
      enabled: true,
      supportedSignals: ["traces", "metrics"],
      domains: ["agent", "capacity"],
      filterProfile: "custom",
      encryptedConfig: "ciphertext",
      securityRevision: 1,
    };

    expect(
      observabilityPolicySchema.safeParse({
        ...policy,
        externalDestinations: [custom],
      }).success,
    ).toBe(true);
    expect(
      observabilityPolicySchema.safeParse({
        ...policy,
        externalDestinations: [{ ...custom, supportedSignals: [] }],
      }).success,
    ).toBe(false);
    expect(
      observabilityPolicySchema.safeParse({
        ...policy,
        externalDestinations: [{ ...custom, domains: [] }],
      }).success,
    ).toBe(false);
  });

  test("exposes Built-in capabilities without leaking destination credentials", () => {
    const policy: ObservabilityPolicy = {
      ...createDefaultObservabilityPolicy(4),
      externalDestinations: [
        {
          id: "destination_langfuse",
          kind: "langfuse",
          enabled: true,
          supportedSignals: ["traces"],
          filterProfile: "agent_genai",
          encryptedConfig: "ciphertext",
          securityRevision: 3,
        },
      ],
    };

    const publicPolicy = toPublicObservabilityPolicy(policy);

    expect(publicPolicy.builtIn).toEqual({
      ...BUILT_IN_DESTINATION_CAPABILITY,
      health: {
        status: "waiting",
        lastReceivedAt: null,
      },
    });
    expect(publicPolicy.externalDestinations).toEqual([
      {
        id: "destination_langfuse",
        kind: "langfuse",
        enabled: true,
        supportedSignals: ["traces"],
        filterProfile: "agent_genai",
        securityRevision: 3,
        configured: true,
        health: {
          destinationId: "destination_langfuse",
          status: "pending",
          checkedAt: null,
          lastSuccessAt: null,
          lastError: null,
        },
      },
    ]);
    expect(JSON.stringify(publicPolicy)).not.toContain("ciphertext");
  });

  test("validates external destination credentials and OTLP capabilities", () => {
    expect(
      externalDestinationConfigSchema.parse({
        kind: "elastic",
        endpoint: "https://elastic.example.com:8200",
        authorization: {
          type: "api_key",
          value: "elastic-api-key",
        },
      }),
    ).toMatchObject({ kind: "elastic" });
    expect(
      externalDestinationConfigSchema.parse({
        kind: "langfuse",
        baseUrl: "https://us.cloud.langfuse.com",
        publicKey: "pk-lf",
        secretKey: "sk-lf",
      }),
    ).toMatchObject({
      kind: "langfuse",
      baseUrl: "https://us.cloud.langfuse.com",
    });
    expect(
      langfuseOtlpTracesEndpoint("https://us.cloud.langfuse.com"),
    ).toBe(
      "https://us.cloud.langfuse.com/api/public/otel/v1/traces",
    );
    expect(
      langfuseOtlpTracesEndpoint("https://langfuse.example.com/"),
    ).toBe(
      "https://langfuse.example.com/api/public/otel/v1/traces",
    );
    expect(
      externalDestinationConfigSchema.safeParse({
        kind: "custom_otlp",
        endpoint: "https://otel.example.com",
        supportedSignals: [],
        domains: ["agent"],
        headers: {},
      }).success,
    ).toBe(false);
    expect(
      externalDestinationConfigSchema.safeParse({
        kind: "elastic",
        endpoint: "https://user:secret@elastic.example.com",
        authorization: {
          type: "bearer",
          value: "token",
        },
      }).success,
    ).toBe(false);
    expect(
      externalDestinationConfigSchema.safeParse({
        kind: "custom_otlp",
        endpoint: "https://otel.example.com",
        supportedSignals: ["traces"],
        domains: ["agent"],
        headers: {
          authorization: "Bearer token",
          host: "metadata.internal",
        },
      }).success,
    ).toBe(false);
  });
});

describe("Agent runtime policy", () => {
  const observabilityPolicy: ObservabilityPolicy = {
    ...createDefaultObservabilityPolicy(42),
    externalDestinations: [
      {
        id: "destination_langfuse",
        kind: "langfuse",
        enabled: true,
        supportedSignals: ["traces"],
        filterProfile: "agent_genai",
        encryptedConfig: "must-not-leave-the-control-plane",
        securityRevision: 7,
      },
    ],
  };

  test("contains capture, internal OTLP, and deployment provenance only", () => {
    expect(AGENT_RUNTIME_POLICY_PATH).toBe(
      "/run/eveland/observability/agent-policy.json",
    );
    const runtimePolicy = createAgentRuntimePolicy({
      policy: observabilityPolicy,
      otlpEndpoint: "http://127.0.0.1:4318",
      resource: {
        teamId: "team_1",
        projectId: "proj_1",
        releaseId: "rel_1",
        deploymentId: "dep_1",
        runtimeKind: "systemd",
        environment: "production",
      },
    });

    expect(runtimePolicy).toEqual({
      schemaVersion: 1,
      revision: 42,
      capture: {
        enabled: true,
        sampleRatio: 1,
        recordInputs: true,
        recordOutputs: true,
        includeReasoning: true,
      },
      otlp: { endpoint: "http://127.0.0.1:4318" },
      resource: {
        teamId: "team_1",
        projectId: "proj_1",
        releaseId: "rel_1",
        deploymentId: "dep_1",
        runtimeKind: "systemd",
        environment: "production",
      },
    });
    expect(JSON.stringify(runtimePolicy)).not.toContain("must-not-leave-the-control-plane");
    expect(JSON.stringify(runtimePolicy)).not.toContain("langfuse");
  });

  test("rejects credentials in the Agent-visible OTLP endpoint", () => {
    expect(() =>
      createAgentRuntimePolicy({
        policy: observabilityPolicy,
        otlpEndpoint: "http://collector:secret@127.0.0.1:4318",
        resource: {
          teamId: "team_1",
          projectId: "proj_1",
          releaseId: "rel_1",
          deploymentId: "dep_1",
          runtimeKind: "docker",
          environment: "production",
        },
      }),
    ).toThrow(/credentials/);
  });
});
