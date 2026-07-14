import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BootstrapResult = {
  exitCode?: number;
  all?: string;
};

type BootstrapRun = (
  file: string,
  args: string[],
  options: {
    all: true;
    reject: false;
    extendEnv: false;
    env: { WORKFLOW_POSTGRES_URL: string };
  },
) => Promise<BootstrapResult>;

export type WorkflowWorldBootstrapDeps = {
  run: BootstrapRun;
  wait: (milliseconds: number) => Promise<void>;
  resolveBin: () => string;
  maxAttempts: number;
  retryDelayMs: number;
};

const defaultDeps: WorkflowWorldBootstrapDeps = {
  run: async (file, args, options) => await execa(file, args, options),
  wait: async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)),
  resolveBin() {
    const packageEntry = fileURLToPath(import.meta.resolve("@workflow/world-postgres"));
    return path.resolve(path.dirname(packageEntry), "../bin/setup.js");
  },
  maxAttempts: 30,
  retryDelayMs: 1_000,
};

export async function bootstrapWorkflowWorld(
  env: NodeJS.ProcessEnv,
  overrides: Partial<WorkflowWorldBootstrapDeps> = {},
): Promise<string | undefined> {
  const workflowPostgresUrl = env.WORKFLOW_POSTGRES_URL;
  if (!workflowPostgresUrl) {
    if (env.NODE_ENV === "production") {
      throw new Error("WORKFLOW_POSTGRES_URL is required for the platform-owned durable workflow world in production.");
    }
    return undefined;
  }
  const bootstrapPostgresUrl = resolveBootstrapPostgresUrl(env, workflowPostgresUrl);

  const deps = { ...defaultDeps, ...overrides };
  const bootstrapBin = deps.resolveBin();
  let lastOutput = "bootstrap exited without output";

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt += 1) {
    const result = await deps.run(process.execPath, [bootstrapBin], {
      all: true,
      reject: false,
      extendEnv: false,
      env: { WORKFLOW_POSTGRES_URL: bootstrapPostgresUrl },
    });
    lastOutput = result.all?.trim() || `bootstrap exited with code ${result.exitCode ?? "unknown"}`;
    if (result.exitCode === 0) return lastOutput;
    if (attempt < deps.maxAttempts) await deps.wait(deps.retryDelayMs);
  }

  throw new Error(
    `Platform workflow-world database bootstrap failed after ${deps.maxAttempts} attempt(s): ${redactWorkflowUrl(lastOutput, bootstrapPostgresUrl)}`,
  );
}

function resolveBootstrapPostgresUrl(env: NodeJS.ProcessEnv, workflowPostgresUrl: string): string {
  if (env.WORKFLOW_POSTGRES_BOOTSTRAP_URL) return env.WORKFLOW_POSTGRES_BOOTSTRAP_URL;
  if (env.DATABASE_URL && isHostDatabaseAlias(workflowPostgresUrl, env.DATABASE_URL)) return env.DATABASE_URL;
  return workflowPostgresUrl;
}

function isHostDatabaseAlias(workflowPostgresUrl: string, databaseUrl: string): boolean {
  try {
    const workflow = new URL(workflowPostgresUrl);
    const controlPlane = new URL(databaseUrl);
    const port = (url: URL) => url.port || "5432";

    return (
      workflow.hostname.toLowerCase() === "host.docker.internal" &&
      workflow.protocol === controlPlane.protocol &&
      workflow.username === controlPlane.username &&
      workflow.password === controlPlane.password &&
      port(workflow) === port(controlPlane) &&
      workflow.pathname === controlPlane.pathname &&
      workflow.search === controlPlane.search
    );
  } catch {
    return false;
  }
}

function redactWorkflowUrl(value: string, workflowPostgresUrl: string): string {
  return value
    .replaceAll(workflowPostgresUrl, "[redacted]")
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[redacted]@");
}
