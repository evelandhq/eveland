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
};

export type ProcessStartResult = {
  internalPort: number;
  log: string;
};

export type RuntimeAdapter = {
  readonly name: string;
  buildRelease(input: ReleaseBuildInput): Promise<ReleaseBuildResult>;
  startProcess(input: ProcessStartInput): Promise<ProcessStartResult>;
  stopProcess(processName: string): Promise<void>;
};

export function processSafeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}
