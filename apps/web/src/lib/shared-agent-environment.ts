export type SharedAgentEnvironmentDraft = {
  entries: Array<{
    key: string;
    kind: "variable" | "secret";
    value: string;
    configured: boolean;
  }>;
};

type SharedAgentEnvironmentEntry = SharedAgentEnvironmentDraft["entries"][number];

export function updateSharedAgentEnvironmentEntry(
  entry: SharedAgentEnvironmentEntry,
  patch: Partial<SharedAgentEnvironmentEntry>,
): SharedAgentEnvironmentEntry {
  const identityChanged = (patch.key !== undefined && patch.key !== entry.key)
    || (patch.kind !== undefined && patch.kind !== entry.kind);
  return {
    ...entry,
    ...patch,
    ...(identityChanged ? { configured: false } : {}),
  };
}

export function validateSharedAgentEnvironmentDraft(input: SharedAgentEnvironmentDraft):
  | {
      ok: true;
      input: {
        entries: Array<{ key: string; kind: "variable" | "secret"; value?: string }>;
      };
    }
  | { ok: false; error: string } {
  const keys = input.entries.map((entry) => entry.key.trim().toUpperCase());
  if (new Set(keys).size !== keys.length) {
    return { ok: false, error: "Shared environment keys must be unique." };
  }

  const entries: Array<{ key: string; kind: "variable" | "secret"; value?: string }> = [];
  for (const [index, entry] of input.entries.entries()) {
    const key = keys[index]!;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      return { ok: false, error: `Enter a valid key for entry ${index + 1}.` };
    }
    if (!entry.configured && !entry.value) {
      return { ok: false, error: `Enter a value for ${key}.` };
    }
    entries.push({
      key,
      kind: entry.kind,
      ...(entry.value ? { value: entry.value } : {}),
    });
  }

  return { ok: true, input: { entries } };
}
