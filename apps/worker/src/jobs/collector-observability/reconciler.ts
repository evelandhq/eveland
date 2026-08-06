import { DEFAULT_TEAM_ID, type Store } from "@evelandhq/db";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCollectorConfig } from "./config.js";
import {
  restartCollectorContainer,
  validateCollectorConfig,
  type CollectorConfigLocation,
} from "./control.js";

const devSecretKey = "eveland-dev-secret-key-000000000";

export function createCollectorObservabilityReconciler(input: {
  store: Store;
  env: NodeJS.ProcessEnv;
  validateConfig?: (location: CollectorConfigLocation) => Promise<void>;
  restartCollector?: () => Promise<void>;
}): () => Promise<number> {
  let appliedRevision: number | undefined;
  let inFlight: Promise<number> | undefined;
  const validateConfig =
    input.validateConfig ?? ((location) => validateCollectorConfig(location, input.env));
  const restartCollector = input.restartCollector ?? (() => restartCollectorContainer(input.env));

  const reconcile = async (): Promise<number> => {
    const policy = await input.store.getObservabilityPolicy(DEFAULT_TEAM_ID);
    if (policy.revision === appliedRevision) return 0;

    const config = renderCollectorConfig({
      policy,
      appSecretKey: input.env.APP_SECRET_KEY ?? devSecretKey,
    });
    const configDirectory = path.resolve(input.env.EVELAND_DATA_DIR ?? ".eveland-data", "otel");
    const hostConfigDirectory = path.resolve(
      input.env.EVELAND_HOST_DATA_DIR ?? input.env.EVELAND_DATA_DIR ?? ".eveland-data",
      "otel",
    );
    const finalPath = path.join(configDirectory, "collector.yaml");
    const candidate = {
      workerPath: path.join(configDirectory, "collector.yaml.candidate"),
      hostPath: path.join(hostConfigDirectory, "collector.yaml.candidate"),
    };
    const previous = await readFile(finalPath, "utf8").catch(() => null);
    if (previous === config) {
      appliedRevision = policy.revision;
      return 0;
    }

    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await rm(candidate.workerPath, { force: true });
    await writeFile(candidate.workerPath, config, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await validateConfig(candidate);
      await rename(candidate.workerPath, finalPath);
      try {
        await restartCollector();
      } catch (error) {
        if (previous === null) {
          await rm(finalPath, { force: true });
        } else {
          const rollbackPath = `${finalPath}.rollback`;
          await writeFile(rollbackPath, previous, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(rollbackPath, finalPath);
          await restartCollector().catch(() => undefined);
        }
        throw error;
      }
    } finally {
      await rm(candidate.workerPath, { force: true });
    }

    appliedRevision = policy.revision;
    return 1;
  };

  return () => {
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
