export function maskKnownSecrets(input: string, values: string[]): string {
  let output = input;
  const uniqueValues = [...new Set(values.filter((value) => value.length >= 8))];

  for (const value of uniqueValues) {
    output = output.split(value).join("***");
  }

  return output;
}

export function mergeRuntimeEnvironment(input: {
  projectSecrets: Readonly<Record<string, string>>;
  sharedEnvironment?: Readonly<Record<string, string>>;
  reserved?: Readonly<Record<string, string>>;
}): Record<string, string> {
  return {
    ...input.sharedEnvironment,
    ...input.projectSecrets,
    ...input.reserved,
  };
}
