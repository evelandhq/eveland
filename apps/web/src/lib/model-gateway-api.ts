import { apiRequest, type ApiRequestOptions } from "./api-transport";

export type ModelGatewayProvider = {
  id: string;
  providerId: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type ModelGatewayModelRoute = {
  id: string;
  modelId: string;
  providerId: string;
  providerModelId: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelGatewayRegistryEvent = {
  id: string;
  kind: string;
  subject: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

export type ModelGatewayApiKey = {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
};

async function request<T>(path: string, init: ApiRequestOptions): Promise<T> {
  return apiRequest<T>(path, init);
}

export async function listModelGatewayModels(): Promise<ModelGatewayModelRoute[]> {
  return request<{ models: ModelGatewayModelRoute[] }>("/model-gateway/models", {
    method: "GET",
  }).then((data) => data.models);
}

export async function listModelGatewayProviders(): Promise<ModelGatewayProvider[]> {
  return request<{ providers: ModelGatewayProvider[] }>("/system/model-gateway/providers", {
    method: "GET",
  }).then((data) => data.providers);
}

export async function saveModelGatewayProvider(input: {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}): Promise<ModelGatewayProvider> {
  return request<{ provider: ModelGatewayProvider }>(
    `/system/model-gateway/providers/${encodeURIComponent(input.providerId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ name: input.name, baseUrl: input.baseUrl, apiKey: input.apiKey }),
    },
  ).then((data) => data.provider);
}

export async function deleteModelGatewayProvider(providerId: string): Promise<void> {
  await request(`/system/model-gateway/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

export async function upsertModelGatewayModelRoute(input: {
  modelId: string;
  providerId: string;
  providerModelId: string;
  displayName?: string;
}): Promise<void> {
  await request("/system/model-gateway/models", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteModelGatewayModelRoute(modelId: string): Promise<void> {
  await request("/system/model-gateway/models", {
    method: "DELETE",
    body: JSON.stringify({ modelId }),
  });
}

export async function listModelGatewayRegistryEvents(): Promise<ModelGatewayRegistryEvent[]> {
  return request<{ events: ModelGatewayRegistryEvent[] }>("/system/model-gateway/registry-events", {
    method: "GET",
  }).then((data) => data.events);
}

export async function mintModelGatewayApiKey(
  name: string,
): Promise<{ token: string; key: ModelGatewayApiKey }> {
  return request<{ token: string; key: ModelGatewayApiKey }>("/model-gateway/api-keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function listModelGatewayApiKeys(): Promise<ModelGatewayApiKey[]> {
  return request<{ keys: ModelGatewayApiKey[] }>("/model-gateway/api-keys", {
    method: "GET",
  }).then((data) => data.keys);
}

export async function revokeModelGatewayApiKey(id: string): Promise<void> {
  await request(`/model-gateway/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}
