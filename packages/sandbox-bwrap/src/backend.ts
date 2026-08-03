import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { SandboxBackend, SandboxSeedFile } from "eve/sandbox";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import type { BwrapSandboxCreateOptions } from "./options.js";
import { createBwrapOptionsHash, resolveBwrapSandboxOptions } from "./options.js";
import { resolveSessionPath, resolveTemplatePath, WORKSPACE_ROOT } from "./paths.js";
import type { ProcessRunner } from "./process.js";
import { createNodeProcessRunner, describeMissingPrereqs, isBwrapAvailable } from "./process.js";
import type { BwrapSession } from "./session.js";
import { createBwrapSession } from "./session.js";

const EVE_MODEL_SKILL_ROOT = "$HOME/.agents/skills";

/**
 * Stable backend name. Participates in eve's template/session cache-key
 * derivation and persisted reconnect state — never change it.
 */
export const BWRAP_BACKEND_NAME = "bwrap";

export interface CreateBwrapSandboxBackendInput {
  readonly createOptions?: BwrapSandboxCreateOptions;
  /** Injectable process launcher so backend logic is testable without bwrap. */
  readonly runner?: ProcessRunner;
}

async function copyDirectoryAtomically(sourcePath: string, targetPath: string): Promise<void> {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await cp(sourcePath, tmpPath, { recursive: true });
    await rename(tmpPath, targetPath);
  } catch (error) {
    await rm(tmpPath, { force: true, recursive: true }).catch(() => {});
    // A concurrent writer winning the rename race is success, not failure.
    if (existsSync(targetPath)) return;
    throw error;
  }
}

export function createBwrapSandboxBackend(
  input: CreateBwrapSandboxBackendInput = {},
): SandboxBackend {
  const options = resolveBwrapSandboxOptions(input.createOptions);
  const optionsHash = createBwrapOptionsHash(options);
  const runner = input.runner ?? createNodeProcessRunner();
  // Probe only when running against the real bwrap; injected runners skip it.
  const shouldProbe = input.runner === undefined;
  let probed = false;

  function assertBwrapAvailable(): void {
    if (!shouldProbe || probed) return;
    const missing = describeMissingPrereqs({
      bwrapPresent: isBwrapAvailable(options.bwrapPath),
      workspaceMountpointPresent: existsSync(WORKSPACE_ROOT),
      bwrapPath: options.bwrapPath,
    });
    if (missing) throw new Error(missing);
    probed = true;
  }

  function openSession(id: string, workspaceDir: string, appRoot: string): BwrapSession {
    return createBwrapSession({ id, workspaceDir, appRoot, runner, options });
  }

  function resolveSeedPath(seedPath: string): string {
    if (seedPath === EVE_MODEL_SKILL_ROOT || seedPath.startsWith(`${EVE_MODEL_SKILL_ROOT}/`)) {
      return `${WORKSPACE_ROOT}/.agents/skills${seedPath.slice(EVE_MODEL_SKILL_ROOT.length)}`;
    }
    return seedPath;
  }

  async function writeSeedFiles(
    session: BwrapSession,
    seedFiles: ReadonlyArray<SandboxSeedFile>,
  ): Promise<void> {
    for (const seed of seedFiles) {
      const seedPath = resolveSeedPath(seed.path);
      if (typeof seed.content === "string") {
        await session.writeTextFile({ path: seedPath, content: seed.content });
      } else {
        await session.writeBinaryFile({ path: seedPath, content: seed.content });
      }
    }
  }

  return {
    name: BWRAP_BACKEND_NAME,

    async prewarm({ templateKey, bootstrap, seedFiles, log, runtimeContext }) {
      assertBwrapAvailable();
      const templatePath = resolveTemplatePath(
        runtimeContext.appRoot,
        templateKey,
        optionsHash,
        options.cacheDir,
      );
      if (existsSync(templatePath)) return { reused: true };

      log?.(`bwrap: capturing template for ${templateKey}`);
      const stagingPath = `${templatePath}.staging-${randomUUID()}`;
      await mkdir(stagingPath, { recursive: true });
      try {
        const session = openSession(templateKey, stagingPath, runtimeContext.appRoot);
        if (bootstrap) await bootstrap({ use: async () => session });
        await writeSeedFiles(session, seedFiles);
        await rename(stagingPath, templatePath);
      } catch (error) {
        await rm(stagingPath, { force: true, recursive: true }).catch(() => {});
        // A concurrent prewarm winning the race is reuse, not failure.
        if (existsSync(templatePath)) return { reused: true };
        throw error;
      }
      return { reused: false };
    },

    async create({ templateKey, sessionKey, runtimeContext }) {
      assertBwrapAvailable();
      const sessionPath = resolveSessionPath(runtimeContext.appRoot, sessionKey, options.cacheDir);
      if (!existsSync(sessionPath)) {
        if (templateKey === null) {
          await mkdir(sessionPath, { recursive: true });
        } else {
          const templatePath = resolveTemplatePath(
            runtimeContext.appRoot,
            templateKey,
            optionsHash,
            options.cacheDir,
          );
          if (!existsSync(templatePath)) {
            throw new SandboxTemplateNotProvisionedError({
              backendName: BWRAP_BACKEND_NAME,
              templateKey,
            });
          }
          await copyDirectoryAtomically(templatePath, sessionPath);
        }
      }
      const session = openSession(sessionKey, sessionPath, runtimeContext.appRoot);
      return {
        session,
        useSessionFn: async () => session,
        async captureState() {
          return { backendName: BWRAP_BACKEND_NAME, metadata: {}, sessionKey };
        },
        // eve calls this when the server is shutting down: nothing may be left
        // running afterwards. The workspace directory IS the durable state, so
        // it stays on disk and the session reattaches on the next start.
        async shutdown() {
          await session.killAll();
        },
      };
    },
  };
}
