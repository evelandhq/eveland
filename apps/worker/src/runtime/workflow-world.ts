import type { ReleaseWorkflowAttestation } from "@evelandhq/core/contracts";
import { access, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PNPM_RELEASE_AGE_CONFIG,
  pnpmSharedStoreArgs,
  type PnpmSharedStore,
} from "./package-manager.js";

/**
 * The platform's world: one shared database, tenancy as a column, and the
 * external dispatcher driving every run, so durable timers survive the idle
 * reaper.
 *
 * The version must equal the one `apps/worker` itself depends on: CI runs the
 * eve/World contract tests against the installed copy, so injecting any other
 * version would ship one the gate never saw. Asserted by
 * eve-workflow-world-contract.test.ts.
 */
export const EVELAND_WORKFLOW_WORLD = {
  packageName: "@evelandhq/workflow-world",
  packageVersion: "2.0.0",
} as const;

export type WorkflowWorldBuildConfig = {
  packageName: string;
  packageVersion: string;
};

/**
 * The Workflow SDK storage spec the shared World serves (the single
 * orchestrator, which eve asks for by default and the World fences in band)
 * and the Eveland external dispatch protocol it implements. The eve/World
 * contract suite asserts the spec against what the installed package's dist
 * declares.
 */
const EVELAND_WORKFLOW_WORLD_STORAGE_SPEC = 9;
const EVELAND_WORKFLOW_WORLD_DISPATCH_PROTOCOL = 2;

/**
 * Maps the injected world package onto the Release's immutable workflow
 * attestation. Any other package attests `unknown`, which no launch accepts.
 */
export function deriveWorkflowWorldAttestation(
  config: WorkflowWorldBuildConfig,
): ReleaseWorkflowAttestation {
  if (config.packageName === EVELAND_WORKFLOW_WORLD.packageName) {
    return {
      worldKind: "shared",
      worldPackage: config.packageName,
      worldVersion: config.packageVersion,
      storageSpec: EVELAND_WORKFLOW_WORLD_STORAGE_SPEC,
      dispatchProtocol: EVELAND_WORKFLOW_WORLD_DISPATCH_PROTOCOL,
    };
  }
  return {
    worldKind: "unknown",
    worldPackage: config.packageName,
    worldVersion: config.packageVersion,
    storageSpec: null,
    dispatchProtocol: null,
  };
}

export type WorkflowWorldInjectionResult = {
  agentConfigPath: string;
  authoredConfigPath?: string;
};

const agentConfigPattern = /^agent\.(?:cts|mts|cjs|mjs|ts|js)$/;
const defaultEveAgentModel = "anthropic/claude-sonnet-5";

export function buildWorkflowWorldInstallCommand(
  config: WorkflowWorldBuildConfig,
  packageManager: "npm" | "pnpm",
  pnpmStore?: PnpmSharedStore,
): string {
  const packageSpec = `${config.packageName}@${config.packageVersion}`;
  if (packageManager === "pnpm") {
    return (
      'manifest_backup="$(mktemp)"' +
      ' && cp package.json "$manifest_backup"' +
      ' && trap \'cp "$manifest_backup" package.json; rm -f "$manifest_backup"\' EXIT' +
      ` && pnpm add --lockfile=false --ignore-scripts ${PNPM_RELEASE_AGE_CONFIG}${pnpmSharedStoreArgs(pnpmStore)} ${packageSpec}`
    );
  }
  return `npm install --no-save --package-lock=false --ignore-scripts ${packageSpec}`;
}

export async function injectWorkflowWorld(input: {
  releaseDir: string;
  config: WorkflowWorldBuildConfig;
}): Promise<WorkflowWorldInjectionResult> {
  const releaseDir = path.resolve(input.releaseDir);
  const nestedAgentRoot = path.join(releaseDir, "agent");
  const agentRoot = (await isDirectory(nestedAgentRoot)) ? nestedAgentRoot : releaseDir;
  const entries = await readdir(agentRoot).catch(() => []);
  const authoredConfigs = entries.filter((entry) => agentConfigPattern.test(entry));

  if (authoredConfigs.length > 1) {
    throw new Error(
      `Cannot inject the platform workflow world: multiple root agent config modules were found (${authoredConfigs.join(", ")}).`,
    );
  }

  const generatedConfigPath = path.join(agentRoot, "agent.ts");
  let authoredConfigPath: string | undefined;
  let source: string;
  const [authoredConfig] = authoredConfigs;

  if (authoredConfig) {
    const extension = path.extname(authoredConfig);
    const reservedName = `eveland-authored-agent${extension}`;
    const reservedPath = path.join(agentRoot, reservedName);
    if (await exists(reservedPath)) {
      throw new Error(
        `Reserved workflow-world config already exists at ${path.relative(releaseDir, reservedPath)}. Rename the authored file; Eveland will not overwrite it.`,
      );
    }
    await rename(path.join(agentRoot, authoredConfig), reservedPath);
    authoredConfigPath = path.relative(releaseDir, reservedPath);
    source = createWrappedAgentConfigSource(reservedName, input.config.packageName);
  } else {
    source = createDefaultAgentConfigSource(input.config.packageName);
  }

  await writeFile(generatedConfigPath, source, "utf8");
  return {
    agentConfigPath: path.relative(releaseDir, generatedConfigPath),
    ...(authoredConfigPath ? { authoredConfigPath } : {}),
  };
}

// eve 1.0 accepts only an agent config that carries defineAgent's brand, a
// non-enumerable symbol that the spread below drops. The wrapper re-brands the
// result only when the authored export carried it, so a config eve itself
// would reject (a plain object on 1.0) is still rejected rather than laundered.
function createWrappedAgentConfigSource(authoredFileName: string, world: string): string {
  return `// Generated by Eveland in the prepared Release; imported source is unchanged.
import { defineAgent } from "eve";
import authoredAgentConfig from ${JSON.stringify(`./${authoredFileName}`)};

const authoredAgent = authoredAgentConfig as Record<string, unknown> & {
  experimental?: Record<string, unknown> & {
    workflow?: Record<string, unknown>;
  };
};

const wrappedAgent = {
  ...authoredAgent,
  experimental: {
    ...authoredAgent.experimental,
    workflow: {
      ...authoredAgent.experimental?.workflow,
      world: ${JSON.stringify(world)},
    },
  },
};

export default Reflect.get(authoredAgent, Symbol.for("eve.defined-agent")) === true
  ? defineAgent(wrappedAgent as Parameters<typeof defineAgent>[0])
  : wrappedAgent;
`;
}

function createDefaultAgentConfigSource(world: string): string {
  return `// Generated by Eveland in the prepared Release; imported source is unchanged.
import { defineAgent } from "eve";

export default defineAgent({
  model: ${JSON.stringify(defaultEveAgentModel)},
  experimental: {
    workflow: {
      world: ${JSON.stringify(world)},
    },
  },
});
`;
}

async function isDirectory(target: string): Promise<boolean> {
  return readdir(target).then(
    () => true,
    () => false,
  );
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}
