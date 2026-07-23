import { describe, expect, test } from "vitest";
import {
  AGENT_RUNTIME_POLICY_PATH,
  BUILT_IN_DESTINATION_CAPABILITY,
  createAgentRuntimePolicy,
  createDefaultObservabilityPolicy,
  observabilityPolicySchema,
  type ObservabilityPolicy,
} from "./observability.js";

describe("observability policy", () => {
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
        recordInputs: false,
        recordOutputs: false,
        includeReasoning: false,
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
        recordInputs: false,
        recordOutputs: false,
        includeReasoning: false,
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
