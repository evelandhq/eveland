import type { LogRecord } from "@eveland/core/contracts";
import { createId } from "@eveland/core/ids";
import type { MemoryState } from "./memory-state.js";
import type { MemoryDomain } from "./memory-store-support.js";
import type { LogStore } from "./store-domains.js";

export function createMemoryLogStore(state: MemoryState): MemoryDomain<LogStore> {
  return {
    async appendLog(input) {
      const log: LogRecord = {
        id: createId("log"),
        projectId: input.projectId,
        deploymentId: input.deploymentId ?? null,
        type: input.type,
        line: input.line,
        createdAt: new Date().toISOString(),
      };
      state.logs.push(log);
      return log;
    },

    async listLogs(projectId, type) {
      return state.logs.filter((log) => log.projectId === projectId && (!type || log.type === type));
    },

  };
}
