import { randomBytes } from "node:crypto";

import type { Store } from "@evelandhq/db";
import {
  MODEL_GATEWAY_ENV,
  modelGatewayIdentity,
  modelGatewayIssuesProjectKeys,
  modelGatewayKeyAlias,
  type ModelGatewayRecord,
  type ProjectModelGatewayRecord,
} from "@evelandhq/core/model-gateway";
import {
  deleteLiteLlmKey,
  generateLiteLlmKey,
  liteLlmKeyExists,
  regenerateLiteLlmKey,
} from "@evelandhq/core/server/model-gateway-client";
import { decryptSecretValue, encryptSecretValue } from "@evelandhq/core/server/secrets";

import { parseEncryptedSecret } from "./encrypted-secret.js";

/**
 * Resolves the reserved EVELAND_MODEL_GATEWAY_* variables for one project's
 * launch, issuing the project's key on a key-issuing gateway first.
 *
 * The three names are always reserved -- empty when the project uses no Model
 * Gateway -- so a project entry can never point the injected provider at a
 * gateway of its own choosing.
 *
 * Issuing is crash-safe by ordering: the key value is generated here and
 * stored (encrypted, `pending`) before the gateway ever sees it, because the
 * gateway keeps only a hash. A retry that finds the alias taken checks whether
 * the stored value is the one holding it. A failure fails the launch; there is
 * no fallback to a shared key.
 */

export type ModelGatewayKeyClient = {
  generate: typeof generateLiteLlmKey;
  exists: typeof liteLlmKeyExists;
  regenerate: typeof regenerateLiteLlmKey;
  delete: typeof deleteLiteLlmKey;
};

export const liteLlmKeyClient: ModelGatewayKeyClient = {
  generate: generateLiteLlmKey,
  exists: liteLlmKeyExists,
  regenerate: regenerateLiteLlmKey,
  delete: deleteLiteLlmKey,
};

/** How long a rotated-out key keeps working, covering the restart onto the new one. */
export const MODEL_GATEWAY_ROTATION_GRACE_PERIOD = "1h";

type Options = {
  appSecretKey: string;
  client?: ModelGatewayKeyClient;
  now?: () => Date;
};

export type ModelGatewayEnvironmentStore = Pick<
  Store,
  | "getModelGatewayRecord"
  | "getProjectModelGatewayRecord"
  | "saveIssuedModelGatewayKey"
  | "savePendingModelGatewayRotationKey"
>;

export type ModelGatewayEnvironment = {
  env: Record<(typeof MODEL_GATEWAY_ENV)[keyof typeof MODEL_GATEWAY_ENV], string>;
  secretValues: string[];
};

const inactive: ModelGatewayEnvironment = {
  env: { [MODEL_GATEWAY_ENV.kind]: "", [MODEL_GATEWAY_ENV.url]: "", [MODEL_GATEWAY_ENV.key]: "" },
  secretValues: [],
};

export async function resolveModelGatewayEnvironment(
  store: ModelGatewayEnvironmentStore,
  projectId: string,
  options: Options,
): Promise<ModelGatewayEnvironment> {
  const gateway = await store.getModelGatewayRecord();
  if (gateway === null) return inactive;
  const project = await store.getProjectModelGatewayRecord(projectId);
  if (project.mode === "off") return inactive;

  const key = await resolveProjectKey(store, gateway, project, options);
  return {
    env: {
      [MODEL_GATEWAY_ENV.kind]: gateway.kind,
      [MODEL_GATEWAY_ENV.url]: gateway.baseUrl ?? "",
      [MODEL_GATEWAY_ENV.key]: key,
    },
    secretValues: [key],
  };
}

async function resolveProjectKey(
  store: ModelGatewayEnvironmentStore,
  gateway: ModelGatewayRecord,
  project: ProjectModelGatewayRecord,
  options: Options,
): Promise<string> {
  const decrypt = (value: string) =>
    decryptSecretValue(parseEncryptedSecret(value), options.appSecretKey);

  if (project.mode === "project-key") {
    if (project.encryptedProjectKey === null) {
      throw new Error(
        "This project is set to use its own Model Gateway key, but none is configured. Add the key in Project Settings, or switch the project back to the platform key.",
      );
    }
    return decrypt(project.encryptedProjectKey);
  }
  if (!modelGatewayIssuesProjectKeys(gateway.kind)) return decrypt(gateway.encryptedCredential);
  return ensureIssuedKey(store, gateway, project, options);
}

async function ensureIssuedKey(
  store: ModelGatewayEnvironmentStore,
  gateway: ModelGatewayRecord,
  project: ProjectModelGatewayRecord,
  options: Options,
): Promise<string> {
  const decrypt = (value: string) =>
    decryptSecretValue(parseEncryptedSecret(value), options.appSecretKey);
  const identity = modelGatewayIdentity(gateway);
  let issued = project.issuedKey;

  if (issued !== null && issued.gatewayIdentity === identity && issued.state === "registered") {
    return decrypt(issued.encryptedKey);
  }
  if (issued === null || issued.gatewayIdentity !== identity) {
    issued = {
      alias: modelGatewayKeyAlias(project.projectId),
      encryptedKey: encrypt(generateProjectKey(), options.appSecretKey),
      gatewayIdentity: identity,
      state: "pending",
      issuedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await store.saveIssuedModelGatewayKey(project.projectId, issued);
  }

  const key = decrypt(issued.encryptedKey);
  const client = options.client ?? liteLlmKeyClient;
  const call = { baseUrl: gateway.baseUrl ?? "", adminKey: decrypt(gateway.encryptedCredential) };
  const created = await client.generate({
    ...call,
    key,
    alias: issued.alias,
    metadata: { eveland_project_id: project.projectId },
  });
  if (created.status === "alias-taken" && !(await client.exists({ ...call, key }))) {
    throw new Error(
      `The Model Gateway already has a key with alias ${issued.alias} that Eveland did not issue to this project, so it cannot issue another key under that alias: another key holds it. Delete or rename that key on the gateway, then deploy again.`,
    );
  }
  await store.saveIssuedModelGatewayKey(project.projectId, { ...issued, state: "registered" });
  return key;
}

/**
 * Replaces the project's issued key. The replacement is stored before the
 * gateway sees it; a retry after an interrupted call first checks whether the
 * gateway already holds the stored replacement.
 */
export async function rotateProjectModelGatewayKey(
  store: ModelGatewayEnvironmentStore,
  projectId: string,
  options: Options,
): Promise<{ status: "rotated" | "nothing-to-rotate" }> {
  const gateway = await store.getModelGatewayRecord();
  const project = await store.getProjectModelGatewayRecord(projectId);
  const issued = project.issuedKey;
  if (
    gateway === null ||
    issued === null ||
    issued.state !== "registered" ||
    issued.gatewayIdentity !== modelGatewayIdentity(gateway)
  ) {
    if (project.encryptedPendingRotationKey !== null) {
      await store.savePendingModelGatewayRotationKey(projectId, null);
    }
    return { status: "nothing-to-rotate" };
  }

  const decrypt = (value: string) =>
    decryptSecretValue(parseEncryptedSecret(value), options.appSecretKey);
  let encryptedPending = project.encryptedPendingRotationKey;
  if (encryptedPending === null) {
    encryptedPending = encrypt(generateProjectKey(), options.appSecretKey);
    await store.savePendingModelGatewayRotationKey(projectId, encryptedPending);
  }
  const client = options.client ?? liteLlmKeyClient;
  const call = { baseUrl: gateway.baseUrl ?? "", adminKey: decrypt(gateway.encryptedCredential) };
  const newKey = decrypt(encryptedPending);
  if (!(await client.exists({ ...call, key: newKey }))) {
    await client.regenerate({
      ...call,
      key: decrypt(issued.encryptedKey),
      newKey,
      gracePeriod: MODEL_GATEWAY_ROTATION_GRACE_PERIOD,
    });
  }
  await store.saveIssuedModelGatewayKey(projectId, {
    ...issued,
    encryptedKey: encryptedPending,
    issuedAt: (options.now?.() ?? new Date()).toISOString(),
  });
  await store.savePendingModelGatewayRotationKey(projectId, null);
  return { status: "rotated" };
}

/**
 * Revokes the project's issued key before the project is deleted. A key
 * issued on a gateway the instance no longer uses cannot be reached any more;
 * it is reported so the deletion log can tell the admin to remove it.
 */
export async function revokeProjectModelGatewayKey(
  store: ModelGatewayEnvironmentStore,
  projectId: string,
  options: Options,
): Promise<{ status: "revoked" | "none" } | { status: "orphaned"; alias: string }> {
  const project = await store.getProjectModelGatewayRecord(projectId);
  const issued = project.issuedKey;
  if (issued === null) return { status: "none" };
  const gateway = await store.getModelGatewayRecord();
  if (gateway === null || issued.gatewayIdentity !== modelGatewayIdentity(gateway)) {
    return { status: "orphaned", alias: issued.alias };
  }
  const decrypt = (value: string) =>
    decryptSecretValue(parseEncryptedSecret(value), options.appSecretKey);
  const client = options.client ?? liteLlmKeyClient;
  const call = { baseUrl: gateway.baseUrl ?? "", adminKey: decrypt(gateway.encryptedCredential) };
  await client.delete({ ...call, key: decrypt(issued.encryptedKey) });
  if (project.encryptedPendingRotationKey !== null) {
    await client.delete({ ...call, key: decrypt(project.encryptedPendingRotationKey) });
    await store.savePendingModelGatewayRotationKey(projectId, null);
  }
  await store.saveIssuedModelGatewayKey(projectId, null);
  return { status: "revoked" };
}

function generateProjectKey(): string {
  // LiteLLM requires a caller-chosen key to start with `sk-` and be at least
  // 16 characters long.
  return `sk-eveland-${randomBytes(32).toString("base64url")}`;
}

function encrypt(value: string, appSecretKey: string): string {
  return JSON.stringify(encryptSecretValue(value, appSecretKey));
}
