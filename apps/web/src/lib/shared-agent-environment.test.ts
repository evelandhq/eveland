import { describe, expect, test } from "vitest";

type EnvironmentModule = {
  validateSharedAgentEnvironmentDraft(input: {
    entries: Array<{
      key: string;
      kind: "variable" | "secret";
      value: string;
      configured: boolean;
    }>;
  }): { ok: true; input: unknown } | { ok: false; error: string };
  updateSharedAgentEnvironmentEntry(
    entry: { key: string; kind: "variable" | "secret"; value: string; configured: boolean },
    patch: Partial<{
      key: string;
      kind: "variable" | "secret";
      value: string;
      configured: boolean;
    }>,
  ): { key: string; kind: "variable" | "secret"; value: string; configured: boolean };
};

async function loadEnvironmentModule(): Promise<EnvironmentModule | null> {
  return import("./shared-agent-environment").catch(
    () => null,
  ) as Promise<EnvironmentModule | null>;
}

describe("shared Agent environment form", () => {
  test("preserves configured entries without copying their values", async () => {
    const module = await loadEnvironmentModule();

    expect(module).not.toBeNull();
    expect(
      module?.validateSharedAgentEnvironmentDraft({
        entries: [
          { key: "OPENAI_API_KEY", kind: "secret", value: "", configured: true },
          { key: "MODEL_REGION", kind: "variable", value: "us-east-1", configured: false },
        ],
      }),
    ).toEqual({
      ok: true,
      input: {
        entries: [
          { key: "OPENAI_API_KEY", kind: "secret" },
          { key: "MODEL_REGION", kind: "variable", value: "us-east-1" },
        ],
      },
    });
  });

  test("allows clearing the shared defaults and rejects missing or duplicate values", async () => {
    const module = await loadEnvironmentModule();

    expect(module?.validateSharedAgentEnvironmentDraft({ entries: [] })).toEqual({
      ok: true,
      input: { entries: [] },
    });
    expect(
      module?.validateSharedAgentEnvironmentDraft({
        entries: [{ key: "NEW_TOKEN", kind: "secret", value: "", configured: false }],
      }),
    ).toEqual({ ok: false, error: "Enter a value for NEW_TOKEN." });
    expect(
      module?.validateSharedAgentEnvironmentDraft({
        entries: [
          { key: "TOKEN", kind: "secret", value: "first", configured: false },
          { key: "TOKEN", kind: "variable", value: "second", configured: false },
        ],
      }),
    ).toEqual({ ok: false, error: "Shared environment keys must be unique." });
  });

  test("requires a new value after changing a configured entry identity", async () => {
    const module = await loadEnvironmentModule();
    const configured = {
      key: "OPENAI_API_KEY",
      kind: "secret" as const,
      value: "",
      configured: true,
    };

    expect(
      module?.updateSharedAgentEnvironmentEntry(configured, { key: "ANTHROPIC_API_KEY" }),
    ).toMatchObject({ key: "ANTHROPIC_API_KEY", configured: false });
    expect(
      module?.updateSharedAgentEnvironmentEntry(configured, { kind: "variable" }),
    ).toMatchObject({ kind: "variable", configured: false });
    expect(
      module?.updateSharedAgentEnvironmentEntry(configured, { value: "rotated" }),
    ).toMatchObject({ value: "rotated", configured: true });
  });
});
