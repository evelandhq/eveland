import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  isSupportedEveVersion,
  unsupportedEveVersionMessage,
} from "@evelandhq/core/eve-compatibility";
import type { ReleaseDiscovery } from "./types.js";
import {
  parseSchedulerDefinitions,
  SCHEDULER_DEFINITIONS_RELEASE_PATH,
  type SchedulerDefinition,
} from "@evelandhq/agent-scheduler";

/**
 * Where the build keeps the output of the `eve info --json` it runs after
 * `eve build`, on the same installed tree. Once a Release is built this output
 * -- not the platform's pre-install static file scan -- is the authority on
 * what the agent contains. The summary is informational; scheduler definitions
 * are read separately below and are a required deployment artifact.
 */
export const EVE_INFO_RELEASE_PATH = ".eveland/eve-info.json";

/** The build's `eve info --json` command, saving its output for the summary. */
export const EVE_INFO_SAVE_COMMAND = `npx eve info --json > ${EVE_INFO_RELEASE_PATH}`;

/**
 * Parses saved `eve info --json` output. eve prints one JSON object, which a
 * line of CLI output may precede, so parsing starts at the first `{`.
 * Unparseable output is null: the summary is informational.
 */
export function parseEveInfoOutput(output: string): unknown {
  const start = output.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start)) as unknown;
  } catch {
    return null;
  }
}

/** eve's compiled agent manifest; read only for the static model IDs it names. */
export const COMPILED_AGENT_MANIFEST_RELEASE_PATH =
  ".output/.eve/compile/compiled-agent-manifest.json";

export async function readReleaseStaticModelIds(releaseDir: string): Promise<string[]> {
  try {
    return collectStaticModelIds(
      JSON.parse(
        await readFile(path.join(releaseDir, COMPILED_AGENT_MANIFEST_RELEASE_PATH), "utf8"),
      ),
    );
  } catch {
    return [];
  }
}

/**
 * Refuses a build whose installed eve is outside the hosted window. The
 * declared specifier only had to be able to resolve inside it (`^1.0.0` may
 * install a newer, unverified minor), so the version the build actually
 * installed is what decides whether the Release can exist. An unreadable
 * version cannot be verified and is refused too.
 */
export function assertHostedEveVersion(resolvedEveVersion: string | null): void {
  if (!isSupportedEveVersion(resolvedEveVersion)) {
    throw new Error(unsupportedEveVersionMessage(resolvedEveVersion));
  }
}

export async function readReleaseDiscovery(releaseDir: string): Promise<ReleaseDiscovery> {
  const resolvedEveVersion = await readResolvedEveVersion(releaseDir);
  assertHostedEveVersion(resolvedEveVersion);
  let eveInfo: unknown = null;
  try {
    eveInfo = parseEveInfoOutput(
      await readFile(path.join(releaseDir, EVE_INFO_RELEASE_PATH), "utf8"),
    );
  } catch {
    // Informational: absent output records no build summary.
  }
  return { eveInfo, resolvedEveVersion };
}

export async function readReleaseSchedulerDefinitions(
  releaseDir: string,
): Promise<SchedulerDefinition[]> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(path.join(releaseDir, SCHEDULER_DEFINITIONS_RELEASE_PATH), "utf8"),
    ) as unknown;
  } catch (error) {
    throw new Error(
      `Required scheduler definitions could not be read from ${SCHEDULER_DEFINITIONS_RELEASE_PATH}.`,
      { cause: error },
    );
  }
  const definitions = parseSchedulerDefinitions(value);
  if (!definitions) {
    throw new Error(
      `Invalid scheduler definitions in ${SCHEDULER_DEFINITIONS_RELEASE_PATH}; refusing to deploy untrusted build output.`,
    );
  }
  return definitions;
}

async function readResolvedEveVersion(releaseDir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(
      await readFile(path.join(releaseDir, "node_modules", "eve", "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * The string model IDs in eve's compiled agent manifest, root first,
 * deduplicated: each agent's `config.model` and `config.compaction.model`,
 * for the root and for every declared subagent. eve flattens nested
 * subagents into the root's `subagents` list and keeps each one's compiled
 * config under `agent`.
 *
 * Only a model authored as a string reaches the injected default provider.
 * An authored model object -- whatever its provider, AI Gateway included --
 * is loaded from the Agent's module and called directly; eve marks it with a
 * `source`, and it is left out. A dynamically selected model compiles to
 * `dynamicModel` and cannot be known before it runs.
 */
export function collectStaticModelIds(manifest: unknown): string[] {
  const ids = new Set<string>();
  const collect = (agent: unknown): void => {
    if (!isRecord(agent) || !isRecord(agent.config)) return;
    for (const model of [agent.config.model, recordField(agent.config.compaction, "model")]) {
      const id = stringModelIdOf(model);
      if (id) ids.add(id);
    }
  };
  collect(manifest);
  if (isRecord(manifest) && Array.isArray(manifest.subagents)) {
    for (const subagent of manifest.subagents) {
      if (isRecord(subagent)) collect(subagent.agent);
    }
  }
  return [...ids];
}

function stringModelIdOf(model: unknown): string | undefined {
  if (!isRecord(model) || model.source !== undefined) return undefined;
  return typeof model.id === "string" && model.id.length > 0 ? model.id : undefined;
}

function recordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
