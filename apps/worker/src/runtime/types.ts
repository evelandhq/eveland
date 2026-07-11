export type RuntimeCommandContext = {
  isEveProject: boolean;
  hasLockfile: boolean;
  scripts: Record<string, string | undefined>;
};

export type ReleaseBuildInput = {
  projectId: string;
  releaseId: string;
  sourcePath: string;
  buildDir: string;
  commandContext: RuntimeCommandContext;
};

export type ReleaseBuildResult = {
  releaseRef: string;
  log: string;
};

export type ProcessStartInput = {
  processName: string;
  releaseRef: string;
  port: number;
  env: Record<string, string>;
  commandContext: RuntimeCommandContext;
  /**
   * Durable per-project eve sandbox session cache dir, granted read-write to the
   * unit and exported as EVELAND_SANDBOX_CACHE_DIR by the systemd adapter. The
   * docker adapter ignores it -- containers get a fresh filesystem per run and
   * eve's sandbox falls back to an ephemeral cache when the env var is unset.
   */
  sandboxCacheDir: string;
  /**
   * Additional container host mappings (docker --add-host format "name:target").
   * Dev-only plumbing so an agent container can resolve its own public domain to
   * the host gateway; the systemd adapter ignores it (host processes use system DNS).
   */
  extraHosts?: string[];
};

export type ProcessStartResult = {
  internalPort: number;
  log: string;
};

export type RuntimeAdapter = {
  // Structural match for the api's RuntimeKind (apps/api/src/types.ts) -- do not
  // import that type here; the worker package must not depend on api.
  readonly name: "docker" | "systemd";
  buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult>;
  startProcess(input: ProcessStartInput): Promise<ProcessStartResult>;
  stopProcess(processName: string): Promise<void>;
};

export function processSafeName(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  // A result made up of nothing but dots (".", "..", "...", ...) is a path
  // traversal segment once callers join it onto a directory (e.g.
  // resolveProjectSandboxCacheDir, which mkdir/chown -R's the result). Not
  // reachable today -- project ids are always nanoids -- but nothing about
  // this function's contract rules it out, so neutralize it here rather than
  // trust every future caller to guard against it.
  if (/^\.+$/.test(sanitized)) {
    return sanitized.replace(/\./g, "-");
  }
  return sanitized;
}
