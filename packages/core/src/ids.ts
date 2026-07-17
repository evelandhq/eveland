import { customAlphabet } from "nanoid";

export const idAlphabet = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const createSuffix = customAlphabet(idAlphabet, 10);
const createDeploymentSuffix = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 8);

export const PROJECT_SLUG_MAX_LENGTH = 53;
export const PROJECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function createId(prefix: string): string {
  return `${prefix}_${createSuffix()}`;
}

export function slugifyProjectName(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  if (!slug) {
    throw new Error("Project name must contain at least one ASCII letter or number.");
  }
  return slug;
}

export function inferProjectSlugFromGitUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/g, "");
  if (!trimmed) return null;

  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    const scpMatch = /^[^@\s]+@[^:\s]+:(.+)$/.exec(trimmed);
    if (!scpMatch?.[1]) return null;
    pathname = scpMatch[1];
  }

  const encodedName = pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "");
  if (!encodedName) return null;
  try {
    return slugifyProjectName(decodeURIComponent(encodedName));
  } catch {
    return null;
  }
}

export function normalizeGitHttpHost(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

export async function claimProjectSlug<T>(
  requestedName: string,
  claim: (candidate: string) => Promise<T | null>,
  options: { maxAttempts?: number } = {},
): Promise<T> {
  const base = slugifyProjectName(requestedName);
  const maxAttempts = options.maxAttempts ?? 10_000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const prefix = base.slice(0, PROJECT_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, "");
    const claimed = await claim(`${prefix}${suffix}`);
    if (claimed !== null) return claimed;
  }
  throw new Error(`Failed to claim a unique project slug after ${maxAttempts} attempts.`);
}

export function createDeploymentKey(): string {
  return createDeploymentSuffix();
}

export async function claimDeploymentKey<T>(
  claim: (candidate: string) => Promise<T | null>,
  options: { generate?: () => string; maxAttempts?: number } = {},
): Promise<T> {
  const generate = options.generate ?? createDeploymentKey;
  const maxAttempts = options.maxAttempts ?? 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const claimed = await claim(generate());
    if (claimed !== null) return claimed;
  }
  throw new Error(`Failed to claim a unique deployment key after ${maxAttempts} attempts.`);
}
