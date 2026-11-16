import { openSecret, sealSecret } from "@evelandhq/core/server/sealed-secret";

export type AgentAuthConfigBinding = {
  agentConnectionId: string;
  method: string;
  securityRevision: number;
};

export function sealAgentAuthConfig(
  config: unknown,
  appSecretKey: string,
  binding: AgentAuthConfigBinding,
): string {
  return sealSecret(
    JSON.stringify(config),
    appSecretKey,
    "agent-auth-config",
    configBinding(binding),
  );
}

export function openAgentAuthConfig(
  value: string,
  appSecretKey: string,
  binding: AgentAuthConfigBinding,
): unknown {
  return JSON.parse(
    openSecret(value, appSecretKey, "agent-auth-config", configBinding(binding)),
  ) as unknown;
}

function configBinding(binding: AgentAuthConfigBinding): Array<string | number> {
  return [binding.agentConnectionId, binding.method, binding.securityRevision];
}
