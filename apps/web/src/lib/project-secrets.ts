export type ProjectEnvironmentEntryDraft = {
  key: string;
  kind: "variable" | "secret";
  value: string;
  configured: boolean;
};

export function validateProjectEnvironmentEntry(
  entry: ProjectEnvironmentEntryDraft,
  existingKeys: string[],
  originalKey?: string,
):
  | { ok: true; input: { key: string; kind: "variable" | "secret"; value?: string } }
  | { ok: false; error: string } {
  const key = entry.key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return { ok: false, error: "Use uppercase letters, numbers, and underscores, starting with a letter." };
  }
  if (existingKeys.some((candidate) => candidate === key && candidate !== originalKey)) {
    return { ok: false, error: "Project environment names must be unique." };
  }
  if (!entry.configured && !entry.value) {
    return { ok: false, error: `Enter a value for ${key}.` };
  }
  return {
    ok: true,
    input: {
      key,
      kind: entry.kind,
      ...(entry.value ? { value: entry.value } : {}),
    },
  };
}
