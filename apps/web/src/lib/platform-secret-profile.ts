export type PlatformSecretProfileDraft = {
  name: string;
  entries: Array<{
    key: string;
    kind: "variable" | "secret";
    value: string;
    configured: boolean;
  }>;
};

export function validatePlatformSecretProfileDraft(input: PlatformSecretProfileDraft):
  | {
      ok: true;
      input: {
        name: string;
        entries: Array<{ key: string; kind: "variable" | "secret"; value?: string }>;
      };
    }
  | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Enter a profile name." };
  if (input.entries.length === 0) return { ok: false, error: "Add at least one profile entry." };
  const keys = input.entries.map((entry) => entry.key.trim().toUpperCase());
  if (new Set(keys).size !== keys.length) return { ok: false, error: "Profile keys must be unique." };

  const entries: Array<{ key: string; kind: "variable" | "secret"; value?: string }> = [];
  for (const [index, entry] of input.entries.entries()) {
    const key = keys[index]!;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return { ok: false, error: `Enter a valid key for entry ${index + 1}.` };
    if (!entry.configured && !entry.value) return { ok: false, error: `Enter a value for ${key}.` };
    entries.push({
      key,
      kind: entry.kind,
      ...(entry.value ? { value: entry.value } : {}),
    });
  }

  return { ok: true, input: { name, entries } };
}
