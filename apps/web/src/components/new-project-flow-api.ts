import { slugifyProjectName } from "@eveland/core/ids";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function uploadZipPreflight(archive: File): Promise<Response> {
  const form = new FormData();
  form.set("archive", archive);
  return fetch(`${apiBaseUrl}/source-preflights`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
}

export async function browserGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, `Request failed with ${response.status}.`));
  return response.json() as Promise<T>;
}

export async function browserGetOptional<T>(path: string): Promise<T | null> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await readError(response, `Request failed with ${response.status}.`));
  return response.json() as Promise<T>;
}

export async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string; issues?: Array<{ message?: string }> };
    return body.detail ?? body.issues?.[0]?.message ?? body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function safeProjectSlug(value: string): string | null {
  try {
    return slugifyProjectName(value);
  } catch {
    return null;
  }
}
