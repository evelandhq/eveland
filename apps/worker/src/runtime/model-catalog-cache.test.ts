import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  MODEL_CATALOG_MAX_AGE_MS,
  MODEL_CATALOG_URL,
  loadModelCatalog,
  seedModelCatalog,
} from "./model-catalog-cache.js";

const catalogBody = {
  models: [
    {
      slug: "anthropic/claude-sonnet-4.5",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-sonnet-4-5",
          contextWindowTokens: 200000,
        },
      ],
    },
  ],
  providerAliases: { "amazon-bedrock": "bedrock" },
};

async function tempCacheFile(): Promise<string> {
  return path.join(
    await mkdtemp(path.join(tmpdir(), "eveland-catalog-")),
    "cache",
    "model-catalog.json",
  );
}

function okFetch(body: unknown = catalogBody) {
  return vi.fn(
    async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 }),
  );
}

describe("loadModelCatalog", () => {
  test("fetches the AI Gateway catalog once and caches it with its fetch time", async () => {
    const cacheFile = await tempCacheFile();
    const fetchImpl = okFetch();
    const now = Date.parse("2026-11-03T00:00:00Z");

    const first = await loadModelCatalog({ cacheFile, fetchImpl, now: () => now });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(MODEL_CATALOG_URL);
    expect(first).toMatchObject({
      source: "fetched",
      catalog: { fetchedAt: "2026-11-03T00:00:00.000Z", ...catalogBody },
    });
    expect(JSON.parse(await readFile(cacheFile, "utf8"))).toEqual(
      first.source === "fetched" ? first.catalog : undefined,
    );
  });

  test("serves the cache without fetching while it is less than a day old", async () => {
    const cacheFile = await tempCacheFile();
    const start = Date.parse("2026-11-03T00:00:00Z");
    await loadModelCatalog({ cacheFile, fetchImpl: okFetch(), now: () => start });
    const fetchImpl = okFetch();

    const result = await loadModelCatalog({
      cacheFile,
      fetchImpl,
      now: () => start + MODEL_CATALOG_MAX_AGE_MS - 1,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      source: "cache",
      catalog: { fetchedAt: "2026-11-03T00:00:00.000Z" },
    });
  });

  test("refreshes a cache older than a day", async () => {
    const cacheFile = await tempCacheFile();
    const start = Date.parse("2026-11-03T00:00:00Z");
    await loadModelCatalog({ cacheFile, fetchImpl: okFetch(), now: () => start });
    const fetchImpl = okFetch();

    const result = await loadModelCatalog({
      cacheFile,
      fetchImpl,
      now: () => start + MODEL_CATALOG_MAX_AGE_MS + 1,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched");
  });

  test("keeps serving a stale cache when the refresh fails", async () => {
    const cacheFile = await tempCacheFile();
    const start = Date.parse("2026-11-03T00:00:00Z");
    await loadModelCatalog({ cacheFile, fetchImpl: okFetch(), now: () => start });

    const result = await loadModelCatalog({
      cacheFile,
      fetchImpl: vi.fn(async () => new Response("down", { status: 503 })),
      now: () => start + 2 * MODEL_CATALOG_MAX_AGE_MS,
    });

    expect(result).toMatchObject({
      source: "stale-cache",
      catalog: { fetchedAt: "2026-11-03T00:00:00.000Z" },
      error: expect.stringContaining("503"),
    });
  });

  test("reports the catalog unavailable when there is no cache and the fetch fails", async () => {
    const result = await loadModelCatalog({
      cacheFile: await tempCacheFile(),
      fetchImpl: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND ai-gateway.vercel.sh");
      }),
    });

    expect(result).toEqual({
      source: "unavailable",
      error: expect.stringContaining("ENOTFOUND"),
    });
  });

  test("rejects a response that is not a model catalog, and never caches it", async () => {
    const cacheFile = await tempCacheFile();

    const result = await loadModelCatalog({ cacheFile, fetchImpl: okFetch({ error: "nope" }) });

    expect(result.source).toBe("unavailable");
    await expect(readFile(cacheFile, "utf8")).rejects.toThrow();
  });

  test("ignores a corrupt cache file and fetches", async () => {
    const cacheFile = await tempCacheFile();
    await loadModelCatalog({ cacheFile, fetchImpl: okFetch() });
    await writeFile(cacheFile, "{not json");
    const fetchImpl = okFetch();

    const result = await loadModelCatalog({ cacheFile, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("fetched");
  });
});

describe("seedModelCatalog", () => {
  // eve 1.0's build reads .eve/cache/model-catalog.json and trusts it without
  // going to the network while fetchedAt is under five minutes old, so the
  // seed is stamped with the time it is written; the real fetch time travels
  // in the build log instead.
  test("writes eve's catalog cache format into the release, stamped as fresh", async () => {
    const releaseDir = await mkdtemp(path.join(tmpdir(), "eveland-catalog-release-"));

    await seedModelCatalog({
      releaseDir,
      catalog: { fetchedAt: "2026-11-01T00:00:00.000Z", ...catalogBody },
      now: () => Date.parse("2026-11-03T08:00:00Z"),
    });

    const written = JSON.parse(
      await readFile(path.join(releaseDir, ".eve", "cache", "model-catalog.json"), "utf8"),
    );
    expect(written).toEqual({
      fetchedAt: "2026-11-03T08:00:00.000Z",
      kind: "eve-model-catalog-cache",
      models: catalogBody.models,
      providerAliases: catalogBody.providerAliases,
      version: 2,
    });
  });
});
