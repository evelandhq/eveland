import {
  ENVIRONMENT_ENTRY_KEY_MESSAGE,
  isValidEnvironmentEntryKey,
  normalizeEnvironmentEntryKey,
} from "@eveland/core/environment-entries";

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
  const key = normalizeEnvironmentEntryKey(entry.key);
  if (!isValidEnvironmentEntryKey(key)) {
    return { ok: false, error: ENVIRONMENT_ENTRY_KEY_MESSAGE };
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
