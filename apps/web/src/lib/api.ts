export type Project = {
  id: string;
  name: string;
  importKind: "git" | "zip";
  gitUrl: string | null;
  status: string;
  deploymentStatus: string;
  sourceRevisionId: string | null;
  releaseId: string | null;
  deploymentId: string | null;
  latestSessionStatus: string | null;
  nextScheduleAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicSecret = {
  id: string;
  projectId: string;
  key: string;
  createdAt: string;
  updatedAt: string;
};

export type Schedule = {
  id: string;
  projectId: string;
  name: string;
  kind: "markdown" | "typescript";
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
  executable: boolean;
  sourcePath: string;
  nextRunAt: string | null;
};

export type Session = {
  id: string;
  projectId: string;
  deploymentId: string | null;
  eveSessionId: string | null;
  continuationToken: string | null;
  trigger: string;
  scheduleId: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  index: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type PlaygroundResult = {
  session: Session | null;
  events: SessionEvent[];
};

export type Job = {
  id: string;
  projectId: string;
  type: "import_source" | "build_deploy" | "restart_deployment" | "trigger_schedule";
  status: "queued" | "running" | "completed" | "failed";
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LogLine = {
  id: string;
  projectId: string;
  deploymentId: string | null;
  type: "build" | "deploy" | "runtime";
  line: string;
  createdAt: string;
};

export type SourceRevision = {
  id: string;
  projectId: string;
  kind: "git" | "zip";
  commitSha: string | null;
  sourcePath: string;
  summary: Record<string, unknown>;
  envVars: string[];
  createdAt: string;
};

export type SourceFile = {
  id: string;
  revisionId: string;
  path: string;
  content: string;
  size: number;
};

const apiBaseUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function getProjects(): Promise<Project[]> {
  const data = await apiGet<{ projects: Project[] }>("/projects", { projects: [] });
  return data.projects;
}

export async function getProject(projectId: string): Promise<Project | null> {
  const data = await apiGet<{ project: Project | null }>(`/projects/${projectId}`, { project: null });
  return data.project;
}

export async function getSecrets(projectId: string): Promise<PublicSecret[]> {
  const data = await apiGet<{ secrets: PublicSecret[] }>(`/projects/${projectId}/secrets`, { secrets: [] });
  return data.secrets;
}

export async function getSchedules(projectId: string): Promise<Schedule[]> {
  const data = await apiGet<{ schedules: Schedule[] }>(`/projects/${projectId}/schedules`, { schedules: [] });
  return data.schedules;
}

export async function getSessions(projectId: string): Promise<Session[]> {
  const data = await apiGet<{ sessions: Session[] }>(`/projects/${projectId}/sessions`, { sessions: [] });
  return data.sessions;
}

export async function getSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const data = await apiGet<{ events: SessionEvent[] }>(`/sessions/${sessionId}/events`, { events: [] });
  return data.events;
}

export async function runPlaygroundMessage(projectId: string, message: string): Promise<PlaygroundResult> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}/playground`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data = (await response.json()) as PlaygroundResult & { error?: string; detail?: string };

  if (!response.ok) {
    throw new Error(data.detail ?? data.error ?? "Playground request failed");
  }

  return data;
}

export async function enqueueBuildDeploy(projectId: string): Promise<Job> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}/build-deploy`, {
    method: "POST",
  });
  const data = (await response.json()) as { job?: Job; error?: string; detail?: string };

  if (!response.ok || !data.job) {
    throw new Error(data.detail ?? data.error ?? "Build deploy request failed");
  }

  return data.job;
}

export async function syncSource(projectId: string, options: { deploy?: boolean } = {}): Promise<Job> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}/sync-source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deploy: options.deploy ?? false }),
  });
  const data = (await response.json()) as { job?: Job; error?: string; detail?: string };

  if (!response.ok || !data.job) {
    throw new Error(data.detail ?? data.error ?? "Source sync request failed");
  }

  return data.job;
}

export async function getLogs(projectId: string): Promise<LogLine[]> {
  const data = await apiGet<{ logs: LogLine[] }>(`/projects/${projectId}/logs`, { logs: [] });
  return data.logs;
}

export async function getSourceRevision(projectId: string): Promise<SourceRevision | null> {
  const data = await apiGet<{ revision: SourceRevision | null }>(`/projects/${projectId}/source/revision`, { revision: null });
  return data.revision;
}

export async function getSourceFiles(projectId: string): Promise<SourceFile[]> {
  const data = await apiGet<{ files: SourceFile[] }>(`/projects/${projectId}/source/files`, { files: [] });
  return data.files;
}

export async function getSourceFile(projectId: string, filePath: string): Promise<SourceFile | null> {
  const data = await apiGet<{ file: SourceFile | null }>(`/projects/${projectId}/source/file?path=${encodeURIComponent(filePath)}`, { file: null });
  return data.file;
}

async function apiGet<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return fallback;
    }

    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}
