import type { TcpProbe } from "./net-probe.ts";
import type { PgEnsureDatabase, PgReady } from "./pg-probe.ts";
import type { Prompter } from "./prompt.ts";

/**
 * Shared IO seams. This module is a leaf on purpose: command modules
 * (lifecycle, bootstrap, implicit-login, status, ...) all consume these types
 * without importing each other, which keeps the import graph acyclic.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type StreamCommand = (
  argv: string[],
  /** `input`, when given, is written to the child's stdin (for values that must not appear in argv). */
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
) => Promise<number | null>;

export type ExecCommand = (
  argv: string[],
  /**
   * `timeoutMs` kills the child and resolves with `code: null`. Only the
   * callers that talk to the network need it, and they must have it: a
   * `git fetch` against a black-holed remote otherwise hangs forever, and the
   * process holding it may be a detached background one nobody will notice.
   */
  options: { cwd: string; timeoutMs?: number },
) => Promise<{ code: number | null; output: string }>;

export type SpawnDaemon = (options: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
}) => Promise<number | undefined>;

export type LifecycleIo = {
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  platform?: NodeJS.Platform;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  execCommand?: ExecCommand;
  spawnDaemon?: SpawnDaemon;
  fileExists?: (filePath: string) => Promise<boolean>;
  isAlive?: (pid: number) => boolean;
  /** Start-time identity of a pid (ps lstart + command); null when gone. */
  processIdentity?: (pid: number) => Promise<string | null>;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  repoRootDir?: string;
  /** First-boot seams (real implementations are wired by default). */
  prompter?: Prompter;
  streamCommand?: StreamCommand;
  tcpProbe?: TcpProbe;
  /** A real Postgres connection + query against a DSN. */
  pgReady?: PgReady;
  /** Creates a missing database over an existing connection to the same server. */
  pgEnsureDatabase?: PgEnsureDatabase;
  openUrl?: (url: string) => Promise<void>;
  random?: (size: number) => Buffer;
  getuid?: () => number;
  writeTextFile?: (filePath: string, content: string) => Promise<void>;
};
