import type { TcpProbe } from "./net-probe.ts";
import type { Prompter } from "./prompt.ts";

/**
 * Shared IO seams. This module is a leaf on purpose: command modules
 * (lifecycle, bootstrap, implicit-login, status, ...) all consume these types
 * without importing each other, which keeps the import graph acyclic.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type StreamCommand = (
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<number | null>;

export type ExecCommand = (
  argv: string[],
  options: { cwd: string },
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
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  repoRootDir?: string;
  /** First-boot seams (real implementations are wired by default). */
  prompter?: Prompter;
  streamCommand?: StreamCommand;
  tcpProbe?: TcpProbe;
  openUrl?: (url: string) => Promise<void>;
  random?: (size: number) => Buffer;
};
