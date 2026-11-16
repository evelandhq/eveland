import { openSecret, sealSecret } from "@evelandhq/core/server/sealed-secret";

export type AgentAuthCredentialBinding = {
  agentConnectionId: string;
  securityRevision: number;
  authMethod: string;
  credentialScope: "connection" | "principal";
  scopeSubject: string;
  credentialKey: string;
};

export function sealAgentAuthCredential(
  credential: unknown,
  appSecretKey: string,
  binding: AgentAuthCredentialBinding,
): string {
  return sealSecret(
    JSON.stringify(credential),
    appSecretKey,
    "agent-auth-credential",
    credentialBinding(binding),
  );
}

export function openAgentAuthCredential(
  value: string,
  appSecretKey: string,
  binding: AgentAuthCredentialBinding,
): unknown {
  return JSON.parse(
    openSecret(value, appSecretKey, "agent-auth-credential", credentialBinding(binding)),
  ) as unknown;
}

function credentialBinding(binding: AgentAuthCredentialBinding): Array<string | number> {
  return [
    binding.agentConnectionId,
    binding.securityRevision,
    binding.authMethod,
    binding.credentialScope,
    binding.scopeSubject,
    binding.credentialKey,
  ];
}
