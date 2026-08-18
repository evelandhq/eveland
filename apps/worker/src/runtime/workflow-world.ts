import type { ReleaseWorkflowAttestation } from "@evelandhq/core/contracts";
import { access, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNPM_RELEASE_AGE_CONFIG } from "./package-manager.js";

/**
 * The world every deployment has been built with until now: one physical
 * database per project, orchestration running inside the agent process.
 */
export const PLATFORM_WORKFLOW_WORLD = {
  packageName: "@workflow/world-postgres",
  packageVersion: "5.0.0-beta.34",
} as const;

/**
 * The platform's own world: one shared database, tenancy as a column, and an
 * optional external runner so durable timers survive the idle reaper.
 *
 * The version must equal the one `apps/worker` itself depends on — CI runs the
 * eve↔world contract tests against the installed copy, so injecting any other
 * version would ship one the gate never saw. Asserted by workflow-world.test.ts.
 */
export const EVELAND_WORKFLOW_WORLD = {
  packageName: "@evelandhq/workflow-world",
  packageVersion: "0.10.0",
} as const;

export type WorkflowWorldBuildConfig = {
  packageName: string;
  packageVersion: string;
};

/**
 * The Workflow SDK storage spec generation and Eveland external dispatch
 * protocol generation the pinned shared world implements. Bumped together
 * with `EVELAND_WORKFLOW_WORLD.packageVersion`; the eve↔world contract suite
 * gates the spec against the installed package.
 */
const EVELAND_WORKFLOW_WORLD_STORAGE_SPEC = 6;
const EVELAND_WORKFLOW_WORLD_DISPATCH_PROTOCOL = 1;

/**
 * Maps what release preparation actually injected onto the Release's
 * immutable workflow attestation. Runner mode is a launch-time input and
 * deliberately absent. The shared world's deployment-side enqueue has scoped
 * every job to the per-run `wfrun:<tenant>:<run>` queue since 0.5.0, so the
 * pinned 0.9.0 attests `per_run_queue_v1`; the legacy world never scoped its
 * jobs and attests `unscoped`.
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
      enqueueCapability: "per_run_queue_v1",
    };
  }
  if (config.packageName === PLATFORM_WORKFLOW_WORLD.packageName) {
    return {
      worldKind: "legacy_project",
      worldPackage: config.packageName,
      worldVersion: config.packageVersion,
      storageSpec: EVELAND_WORKFLOW_WORLD_STORAGE_SPEC,
      dispatchProtocol: null,
      enqueueCapability: "unscoped",
    };
  }
  return {
    worldKind: "unknown",
    worldPackage: config.packageName,
    worldVersion: config.packageVersion,
    storageSpec: null,
    dispatchProtocol: null,
    enqueueCapability: "unknown",
  };
}

/**
 * The runner mode injected into every deployment: `external` only.
 *
 * Every new build bakes in the shared world and leaves claiming to the single
 * external dispatcher. `embedded` let multiple deployments of one project
 * claim and replay each other's runs (issue #278), so an explicit request for
 * it is a configuration error — it must fail closed here, never silently fall
 * back to a topology the platform no longer provisions.
 */
export function resolveWorkflowRunnerMode(env: NodeJS.ProcessEnv): "external" {
  const runner = env.EVELAND_WORKFLOW_RUNNER;
  if (runner === undefined || runner === "" || runner === "external") return "external";
  if (runner === "embedded") {
    throw new Error(
      'EVELAND_WORKFLOW_RUNNER=embedded is not supported: the embedded runner lets concurrent deployments of one project claim each other\'s workflow runs. Unset it or set "external".',
    );
  }
  throw new Error(
    `Invalid EVELAND_WORKFLOW_RUNNER "${runner}": the only supported runner mode is "external".`,
  );
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
): string {
  const packageSpec = `${config.packageName}@${config.packageVersion}`;
  if (packageManager === "pnpm") {
    return (
      'manifest_backup="$(mktemp)"' +
      ' && cp package.json "$manifest_backup"' +
      ' && trap \'cp "$manifest_backup" package.json; rm -f "$manifest_backup"\' EXIT' +
      ` && pnpm add --lockfile=false --ignore-scripts ${PNPM_RELEASE_AGE_CONFIG} ${packageSpec}`
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

function createWrappedAgentConfigSource(authoredFileName: string, world: string): string {
  return `// Generated by Eveland in the prepared Release; imported source is unchanged.
import authoredAgentConfig from ${JSON.stringify(`./${authoredFileName}`)};

const authoredAgent = authoredAgentConfig as Record<string, unknown> & {
  experimental?: Record<string, unknown> & {
    workflow?: Record<string, unknown>;
  };
};

export default {
  ...authoredAgent,
  experimental: {
    ...authoredAgent.experimental,
    workflow: {
      ...authoredAgent.experimental?.workflow,
      world: ${JSON.stringify(world)},
    },
  },
};
`;
}

function createDefaultAgentConfigSource(world: string): string {
  return `// Generated by Eveland in the prepared Release; imported source is unchanged.
export default {
  model: ${JSON.stringify(defaultEveAgentModel)},
  experimental: {
    workflow: {
      world: ${JSON.stringify(world)},
    },
  },
};
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
