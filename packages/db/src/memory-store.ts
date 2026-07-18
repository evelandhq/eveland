import { createMemoryAgentAuthStore } from "./memory-agent-auth-store.js";
import { createMemoryDeploymentStore } from "./memory-deployment-store.js";
import { createMemoryJobStore } from "./memory-job-store.js";
import { createMemoryLogStore } from "./memory-log-store.js";
import { createMemoryProjectSourceStore } from "./memory-project-source-store.js";
import { createMemoryRoutingStore } from "./memory-routing-store.js";
import { createMemoryRuntimeStore } from "./memory-runtime-store.js";
import { createMemoryScheduleStore } from "./memory-schedule-store.js";
import { createMemorySecretStore } from "./memory-secret-store.js";
import { createMemorySessionStore } from "./memory-session-store.js";
import type { MemoryState } from "./memory-state.js";
import type { Store } from "./store-domains.js";

export type StoreState = MemoryState;
export type { MemoryState } from "./memory-state.js";

export function createMemoryStore(initialState?: Partial<MemoryState>): Store {
  const state: MemoryState = {
    projects: initialState?.projects ?? [],
    gitCredentials: initialState?.gitCredentials ?? [],
    sourcePreflights: initialState?.sourcePreflights ?? [],
    agentConnections: initialState?.agentConnections ?? [],
    agentAuthCredentials: initialState?.agentAuthCredentials ?? [],
    agentAuthTransactions: initialState?.agentAuthTransactions ?? [],
    secrets: initialState?.secrets ?? [],
    platformSecretProfiles: initialState?.platformSecretProfiles ?? [],
    platformSecretProfileBindings: initialState?.platformSecretProfileBindings ?? [],
    jobs: initialState?.jobs ?? [],
    schedules: initialState?.schedules ?? [],
    sessions: initialState?.sessions ?? [],
    sessionNodes: initialState?.sessionNodes ?? [],
    sessionEvents: initialState?.sessionEvents ?? [],
    modelUsageEvents: initialState?.modelUsageEvents ?? [],
    logs: initialState?.logs ?? [],
    sourceRevisions: initialState?.sourceRevisions ?? [],
    sourceFiles: initialState?.sourceFiles ?? [],
    releases: initialState?.releases ?? [],
    deployments: initialState?.deployments ?? [],
    agentRoutes: initialState?.agentRoutes ?? [],
    routeTargets: initialState?.routeTargets ?? [],
    sessionBindings: initialState?.sessionBindings ?? [],
    projectSchedules: initialState?.projectSchedules ?? [],
    scheduleVersions: initialState?.scheduleVersions ?? [],
    projectSchedulerTargets: initialState?.projectSchedulerTargets ?? [],
    scheduleRuns: initialState?.scheduleRuns ?? [],
    runtimeInstances: initialState?.runtimeInstances ?? [],
    activationLeases: initialState?.activationLeases ?? [],
  };

  const store: Store = {
    ...createMemoryProjectSourceStore(state),
    ...createMemoryAgentAuthStore(state),
    ...createMemorySecretStore(state),
    ...createMemoryJobStore(state),
    ...createMemoryDeploymentStore(state),
    ...createMemoryRoutingStore(state),
    ...createMemorySessionStore(state),
    ...createMemoryScheduleStore(state),
    ...createMemoryRuntimeStore(state),
    ...createMemoryLogStore(state),
  };
  return store;
}
