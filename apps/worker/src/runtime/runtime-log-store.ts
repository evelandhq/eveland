import type { Store } from "@eveland/db";

type RuntimeLogEmitter = {
  emitLog(input: {
    severity: "info";
    eventName: string;
    body: string;
    attributes: Record<string, string>;
  }): void;
};

export function instrumentRuntimeLogStore(
  store: Store,
  telemetry: RuntimeLogEmitter,
): Store {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "appendLog") {
        return Reflect.get(target, property, receiver);
      }
      return async (input: Parameters<Store["appendLog"]>[0]) => {
        const record = await target.appendLog(input);
        telemetry.emitLog({
          severity: "info",
          eventName: "eveland.runtime.log",
          body: record.line,
          attributes: {
            "eveland.project.id": record.projectId,
            ...(record.deploymentId
              ? { "eveland.deployment.id": record.deploymentId }
              : {}),
            "eveland.log.type": record.type,
          },
        });
        return record;
      };
    },
  });
}
