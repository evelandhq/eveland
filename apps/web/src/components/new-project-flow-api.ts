import { slugifyProjectName } from "@evelandhq/core/ids";

import { apiFetch, apiRequest, decodeApiError } from "@/lib/api-transport";

// Flow-specific request shapes only. Transport, error decoding, and the 401
// policy belong to lib/api-transport, which every control-panel call shares.

export async function uploadZipPreflight(archive: File): Promise<Response> {
  const form = new FormData();
  form.set("archive", archive);
  return apiFetch("/source-preflights", { method: "POST", body: form });
}

export async function browserGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { cache: "no-store" });
}

export async function browserGetOptional<T>(path: string): Promise<T | null> {
  return apiRequest<T>(path, { cache: "no-store", optional: true });
}

export async function readError(response: Response, fallback: string): Promise<string> {
  return decodeApiError(response, fallback);
}

export function safeProjectSlug(value: string): string | null {
  try {
    return slugifyProjectName(value);
  } catch {
    return null;
  }
}
