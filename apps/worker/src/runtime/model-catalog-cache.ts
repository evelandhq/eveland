import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A daily cache of the AI Gateway model catalog, seeded into every Release.
 *
 * eve's build looks up each string model's context window in the catalog at
 * `https://ai-gateway.vercel.sh/v1/models/catalog`. It caches the response in
 * the project's `.eve/cache/model-catalog.json`, trusts that file for five
 * minutes, refetches after that, and falls back to the stale file when the
 * fetch fails. Left alone, every Eveland build therefore goes to Vercel.
 *
 * Instead the Worker fetches the catalog at most once a day into the data
 * directory and writes it into each Release before `eve build`, stamped with
 * the time of writing so the build trusts it. Builds stop depending on
 * reaching Vercel; a failed refresh keeps serving the previous day's copy.
 *
 * The seeded file is eve's own internal cache format (kind
 * `eve-model-catalog-cache`, version 2), pinned by the eve compatibility
 * tests. If eve changes it, eve ignores the file and fetches on its own, which
 * is today's behavior: a build never fails because of the seed.
 */

export const MODEL_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models/catalog";
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export const EVE_MODEL_CATALOG_CACHE_PATH = ".eve/cache/model-catalog.json";

/** Where the Worker keeps its daily copy, relative to EVELAND_DATA_DIR. */
export const MODEL_CATALOG_CACHE_RELATIVE_PATH = "cache/model-catalog.json";

export type CachedModelCatalog = {
  fetchedAt: string;
  models: unknown[];
  providerAliases: Record<string, string>;
};

export type ModelCatalogLoadResult =
  | { source: "cache" | "fetched"; catalog: CachedModelCatalog }
  | { source: "stale-cache"; catalog: CachedModelCatalog; error: string }
  | { source: "unavailable"; error: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const inflight = new Map<string, Promise<ModelCatalogLoadResult>>();

export function loadModelCatalog(input: {
  cacheFile: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<ModelCatalogLoadResult> {
  // Concurrent builds share one refresh instead of each fetching.
  const pending = inflight.get(input.cacheFile);
  if (pending) return pending;
  const load = loadModelCatalogOnce(input).finally(() => inflight.delete(input.cacheFile));
  inflight.set(input.cacheFile, load);
  return load;
}

async function loadModelCatalogOnce(input: {
  cacheFile: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<ModelCatalogLoadResult> {
  const now = input.now ?? Date.now;
  const cached = await readCachedCatalog(input.cacheFile);
  if (cached !== undefined && now() - Date.parse(cached.fetchedAt) < MODEL_CATALOG_MAX_AGE_MS) {
    return { source: "cache", catalog: cached };
  }

  try {
    const catalog = await fetchCatalog(input.fetchImpl ?? fetch, new Date(now()).toISOString());
    await writeAtomically(input.cacheFile, `${JSON.stringify(catalog)}\n`);
    return { source: "fetched", catalog };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return cached === undefined
      ? { source: "unavailable", error: message }
      : { source: "stale-cache", catalog: cached, error: message };
  }
}

async function fetchCatalog(fetchImpl: FetchLike, fetchedAt: string): Promise<CachedModelCatalog> {
  const response = await fetchImpl(MODEL_CATALOG_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`AI Gateway model catalog request failed with HTTP ${response.status}.`);
  }
  const body = readCatalogBody(await response.json());
  if (body === undefined) {
    throw new Error("AI Gateway model catalog response did not match the expected shape.");
  }
  return { fetchedAt, ...body };
}

function readCatalogBody(
  value: unknown,
): Pick<CachedModelCatalog, "models" | "providerAliases"> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { models, providerAliases } = value as Record<string, unknown>;
  if (!Array.isArray(models) || !models.every(isCatalogModel)) return undefined;
  if (typeof providerAliases !== "object" || providerAliases === null) return undefined;
  if (!Object.values(providerAliases).every((alias) => typeof alias === "string")) return undefined;
  return { models, providerAliases: providerAliases as Record<string, string> };
}

function isCatalogModel(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { slug, providers } = value as Record<string, unknown>;
  return typeof slug === "string" && slug.length > 0 && Array.isArray(providers);
}

async function readCachedCatalog(cacheFile: string): Promise<CachedModelCatalog | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, "utf8")) as Record<string, unknown>;
    const body = readCatalogBody(parsed);
    if (body === undefined || typeof parsed.fetchedAt !== "string") return undefined;
    if (!Number.isFinite(Date.parse(parsed.fetchedAt))) return undefined;
    return { fetchedAt: parsed.fetchedAt, ...body };
  } catch {
    return undefined;
  }
}

/** Writes the catalog into a Release in eve's cache format, stamped as fresh. */
export async function seedModelCatalog(input: {
  releaseDir: string;
  catalog: CachedModelCatalog;
  now?: () => number;
}): Promise<void> {
  const target = path.join(input.releaseDir, EVE_MODEL_CATALOG_CACHE_PATH);
  const seed = {
    fetchedAt: new Date((input.now ?? Date.now)()).toISOString(),
    kind: "eve-model-catalog-cache",
    models: input.catalog.models,
    providerAliases: input.catalog.providerAliases,
    version: 2,
  };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
}

async function writeAtomically(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}
