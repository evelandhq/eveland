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
  packageVersion: "0.8.1",
} as const;

export type WorkflowWorldBuildConfig = {
  packageName: string;
  packageVersion: string;
};

/**
 * Which world a project's *next* build bakes in.
 *
 * The choice is a build-time property of the deployment, which is what makes
 * the migration a run-out rather than a data migration: deployments on either
 * world coexist by construction, and rolling back is rebuilding with the flag
 * off.
 *
 * `EVELAND_WORKFLOW_WORLD_ROLLOUT` accepts `off` (default), `all`, or a
 * comma-separated list of project ids. This is deliberately a single seam — if
 * the rollout later wants a per-project column on the projects table, only this
 * function changes.
 */
export function resolveWorkflowWorldChoice(
  env: NodeJS.ProcessEnv,
  projectId: string,
): WorkflowWorldBuildConfig {
  const rollout = (env.EVELAND_WORKFLOW_WORLD_ROLLOUT ?? "off").trim();
  if (rollout === "" || rollout === "off") return PLATFORM_WORKFLOW_WORLD;
  if (rollout === "all") return EVELAND_WORKFLOW_WORLD;
  const allowed = rollout
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return allowed.includes(projectId) ? EVELAND_WORKFLOW_WORLD : PLATFORM_WORKFLOW_WORLD;
}

/**
 * Whether deployments on the platform world run their own graphile runner
 * (`embedded`) or leave claiming to the dispatcher (`external`).
 *
 * Defaults to `embedded`, so turning the world on does not simultaneously
 * change the execution topology — the two are separate, separately reversible
 * steps.
 */
export function resolveWorkflowRunnerMode(env: NodeJS.ProcessEnv): "embedded" | "external" {
  return env.EVELAND_WORKFLOW_RUNNER === "external" ? "external" : "embedded";
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
