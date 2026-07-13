export type RuntimeCommandInput = {
  override?: string | null;
  scripts: Record<string, string | undefined>;
};

export function inferEveRuntimeCommand(input: RuntimeCommandInput): string {
  const override = input.override?.trim();
  if (override) {
    return override;
  }

  if (input.scripts.start) {
    return "npm run start";
  }

  if (input.scripts.dev) {
    return "npm run dev";
  }

  return "npx eve dev --host 0.0.0.0";
}
