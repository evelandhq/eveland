import path from "node:path";
import type { StreamCommand } from "./io.ts";

/**
 * First-boot seeding of the built-in agent: import the in-tree starter
 * template, build it on the platform, and promote it — by shelling out to
 * the real `eveland` CLI with the token the implicit login just minted.
 * The bootstrap walks the exact golden path a user's first deploy walks
 * (same preflight, same upload, same streamed build logs, same promote),
 * so seeding cannot silently diverge from what `eveland deploy` does.
 */

export const BUILT_IN_AGENT_NAME = "stella";
const MODEL_KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

export function cliBinPath(repoRootDir: string): string {
  return path.join(repoRootDir, "packages/cli/src/bin.ts");
}

export function starterTemplateDir(repoRootDir: string): string {
  return path.join(repoRootDir, "templates/starter-agent");
}

export type SeedAgentOptions = {
  repoRootDir: string;
  publicOrigin: string;
  accessToken: string;
  /** The rendered platform env; model keys are forwarded to the agent's project env. */
  envValues: Record<string, string>;
  parentEnv: NodeJS.ProcessEnv;
  streamCommand: StreamCommand;
  print: (line: string) => void;
  nodeBin?: string;
};

/**
 * Idempotent: re-running deploys the same slug again through the CLI's
 * sync-source path, and `env set` overwrites the same keys.
 */
export async function runSeedAgent(options: SeedAgentOptions): Promise<void> {
  const node = options.nodeBin ?? process.execPath;
  const cli = cliBinPath(options.repoRootDir);
  const childEnv: NodeJS.ProcessEnv = {
    ...options.parentEnv,
    EVELAND_TOKEN: options.accessToken,
  };

  options.print(`Seeding the built-in agent (${BUILT_IN_AGENT_NAME})...`);
  const deploy = await options.streamCommand(
    [
      node,
      cli,
      "deploy",
      starterTemplateDir(options.repoRootDir),
      "--origin",
      options.publicOrigin,
      "--name",
      BUILT_IN_AGENT_NAME,
    ],
    { cwd: options.repoRootDir, env: childEnv },
  );
  if (deploy !== 0) {
    throw new Error(
      `Seeding the built-in agent failed (eveland deploy exited ${deploy ?? "abnormally"}); ` +
        "see the output above. Re-run `eveland-ctl start` to retry, or deploy it yourself with " +
        `\`eveland deploy templates/starter-agent --name ${BUILT_IN_AGENT_NAME}\`.`,
    );
  }

  for (const key of MODEL_KEY_NAMES) {
    const value = options.envValues[key];
    if (!value) continue;
    // The key travels on stdin, never in argv: command lines are readable
    // by every local user through ps/proc while the request runs.
    const set = await options.streamCommand(
      [
        node,
        cli,
        "env",
        "set",
        key,
        "--stdin",
        "--origin",
        options.publicOrigin,
        "--name",
        BUILT_IN_AGENT_NAME,
      ],
      { cwd: options.repoRootDir, env: childEnv, input: `${value}\n` },
    );
    if (set !== 0) {
      throw new Error(
        `Setting ${key} on the built-in agent failed (eveland env set exited ${set ?? "abnormally"}). ` +
          `Set it yourself with \`eveland env set ${key} --stdin --name ${BUILT_IN_AGENT_NAME}\`.`,
      );
    }
  }
  options.print(`Built-in agent ${BUILT_IN_AGENT_NAME} is deployed and promoted.`);
}
