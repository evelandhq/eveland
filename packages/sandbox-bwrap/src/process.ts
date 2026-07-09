import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { WORKSPACE_ROOT } from "./paths.js";

/** Mirrors the AI SDK SandboxProcess surface so sessions can return it directly. */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

/** Injectable process launcher so backend logic is unit-testable without bwrap. */
export interface ProcessRunner {
  spawn(argv: readonly string[], options?: { readonly abortSignal?: AbortSignal }): SpawnedProcess;
}

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

export function isBwrapAvailable(bwrapPath = "bwrap"): boolean {
  return spawnSync(bwrapPath, ["--version"], { stdio: "ignore" }).status === 0;
}

/** Explains missing host prerequisites, or null when the host is ready. */
export function describeMissingPrereqs(probes: {
  readonly bwrapPresent: boolean;
  readonly workspaceMountpointPresent: boolean;
  readonly bwrapPath: string;
}): string | null {
  const problems: string[] = [];
  if (!probes.bwrapPresent) {
    problems.push(
      `bubblewrap is not available (tried "${probes.bwrapPath} --version"). ` +
        "Install it with your distro package manager (Ubuntu/Debian: apt-get install bubblewrap), " +
        "or select a different backend outside Linux, e.g. " +
        "backend: () => (isBwrapAvailable() ? bwrap() : defaultBackend()).",
    );
  }
  if (!probes.workspaceMountpointPresent) {
    problems.push(
      `${WORKSPACE_ROOT} does not exist on the host. bwrap binds each session directory onto ` +
        `${WORKSPACE_ROOT} inside the sandbox, but it cannot create that mountpoint itself because the ` +
        `host root is bind-mounted read-only first. Create it once: sudo install -d -m 0755 ${WORKSPACE_ROOT}`,
    );
  }
  return problems.length === 0 ? null : problems.join(" ");
}

export function createNodeProcessRunner(): ProcessRunner {
  return {
    spawn(argv, options) {
      const [command, ...rest] = argv;
      if (!command) {
        throw new Error("ProcessRunner.spawn requires a non-empty argv");
      }
      // detached: the child leads its own process group, so kill(-pid) reaps
      // the entire sandboxed tree (bwrap and everything inside it).
      const child = spawn(command, rest, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const exit = new Promise<{ exitCode: number }>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          resolvePromise({ exitCode: code ?? (signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : 1) });
        });
      });
      exit.catch(() => {});
      const killTree = () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // fall through: group already gone or not yet set up
          }
        }
        child.kill("SIGKILL");
      };
      let aborted = false;
      let abortReason: unknown;
      const signal = options?.abortSignal;
      if (signal) {
        const onAbort = () => {
          aborted = true;
          abortReason = signal.reason;
          killTree();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
        async wait() {
          const result = await exit;
          if (aborted) throw abortReason;
          return result;
        },
        async kill() {
          killTree();
          await exit.catch(() => {});
        },
      };
    },
  };
}
