import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { buildBwrapExecArgs, DEFAULT_SANDBOX_PATH } from "./args.js";
import type { ResolvedBwrapSandboxOptions } from "./options.js";
import { isWithinWorkspace, resolveBwrapCacheRoot, resolveWorkspacePath, toHostPath, WORKSPACE_ROOT } from "./paths.js";
import type { ProcessRunner } from "./process.js";

export interface CreateBwrapSessionInput {
  readonly id: string;
  readonly workspaceDir: string;
  readonly appRoot: string;
  readonly runner: ProcessRunner;
  readonly options: ResolvedBwrapSandboxOptions;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeText(bytes: Buffer, encoding: string): string {
  if (encoding === "utf-8" || encoding === "utf8") {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return bytes.toString(encoding as BufferEncoding);
}

function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split("\n");
  return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
}

export function createBwrapSession(input: CreateBwrapSessionInput): SandboxSession {
  const { id, workspaceDir, appRoot, runner, options } = input;
  let networkPolicy: "allow-all" | "deny-all" = options.networkPolicy;

  const host = (path: string) => toHostPath(path, workspaceDir);

  function writableHostPath(path: string, operation: string): string {
    const hostPath = host(path);
    if (!isWithinWorkspace(hostPath, workspaceDir)) {
      throw new Error(`bwrap sandbox: refusing to ${operation} outside ${WORKSPACE_ROOT}: ${path}`);
    }
    return hostPath;
  }

  async function spawnProcess(spawnOptions: { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal }) {
    const env = {
      PATH: DEFAULT_SANDBOX_PATH,
      HOME: WORKSPACE_ROOT,
      LANG: "C.UTF-8",
      ...options.env,
      ...spawnOptions.env,
    };
    const hidePaths = [resolveBwrapCacheRoot(appRoot), ...options.hidePaths].filter((path) => existsSync(path));
    const argv = buildBwrapExecArgs({
      bwrapPath: options.bwrapPath,
      workspaceDir,
      hidePaths,
      shareNetwork: networkPolicy === "allow-all",
      env,
      chdir: resolveWorkspacePath(spawnOptions.workingDirectory ?? WORKSPACE_ROOT),
      command: spawnOptions.command,
    });
    return runner.spawn(argv, { abortSignal: spawnOptions.abortSignal });
  }

  return {
    id,
    resolvePath: resolveWorkspacePath,

    async spawn(spawnOptions) {
      return await spawnProcess(spawnOptions);
    },

    async run(runOptions) {
      const proc = await spawnProcess(runOptions);
      const [stdout, stderr] = await Promise.all([collectStream(proc.stdout), collectStream(proc.stderr)]);
      const { exitCode } = await proc.wait();
      return { exitCode, stdout, stderr };
    },

    async setNetworkPolicy(policy: SandboxNetworkPolicy) {
      if (policy !== "allow-all" && policy !== "deny-all") {
        throw new Error('bwrap backend supports only the "allow-all" and "deny-all" network policies');
      }
      networkPolicy = policy;
    },

    async readFile({ path }) {
      const hostPath = host(path);
      if (!existsSync(hostPath)) return null;
      return Readable.toWeb(createReadStream(hostPath)) as unknown as ReadableStream<Uint8Array>;
    },

    async readBinaryFile({ path }) {
      try {
        const bytes = await readFile(host(path));
        return new Uint8Array(bytes);
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },

    async readTextFile({ path, encoding, startLine, endLine }) {
      try {
        const bytes = await readFile(host(path));
        return sliceLines(decodeText(bytes, encoding ?? "utf-8"), startLine, endLine);
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },

    async writeFile({ path, content }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      await pipeline(Readable.fromWeb(content as never), createWriteStream(hostPath));
    },

    async writeBinaryFile({ path, content }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      await writeFile(hostPath, content);
    },

    async writeTextFile({ path, content, encoding }) {
      const hostPath = writableHostPath(path, "write");
      await mkdir(dirname(hostPath), { recursive: true });
      const enc = encoding === undefined || encoding === "utf-8" ? "utf8" : encoding;
      await writeFile(hostPath, Buffer.from(content, enc as BufferEncoding));
    },

    async removePath({ path, force, recursive }) {
      const hostPath = writableHostPath(path, "remove");
      if (force !== true && !existsSync(hostPath)) {
        throw new Error(`bwrap sandbox: path does not exist: ${path}`);
      }
      await rm(hostPath, { force: force === true, recursive: recursive === true });
    },
  };
}
