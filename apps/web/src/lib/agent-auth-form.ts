import type { AgentAuthMethodDescriptor } from "@eveland/core/agent-auth";

export function serializeAgentAuthConfig(
  descriptor: AgentAuthMethodDescriptor,
  values: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of descriptor.fields) {
    const value = (values[field.key] ?? "").trim();
    if (!value && field.secret) continue;
    if (!value && field.required) throw new Error(`${field.label} is required.`);
    if (!value) continue;
    if (field.valueType === "string-list") {
      config[field.key] = value.split(/[\s,]+/).filter(Boolean);
      continue;
    }
    if (field.valueType === "json-record") {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${field.label} must be a JSON object.`);
      }
      config[field.key] = parsed;
      continue;
    }
    config[field.key] = value;
  }
  return config;
}

export function agentAuthValuesFromConfig(
  descriptor: AgentAuthMethodDescriptor,
  config: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(descriptor.fields.flatMap((field) => {
    if (field.secret) return [];
    const value = config[field.key];
    if (Array.isArray(value)) return [[field.key, value.join(" ")]];
    return typeof value === "string" ? [[field.key, value]] : [];
  }));
}
