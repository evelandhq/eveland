import type { Job } from "@eveland/core/contracts";
import type { Store } from "@eveland/db";

// The narrow persistence port this handler actually needs.
type ImportSourceStore = Pick<
  Store,
  "getProject" | "appendLog" | "recordSourceRevision" | "upsertGitCredential" | "enqueueJob"
>;
import path from "node:path";
import { scanEveSource } from "../source/scan.js";
import type { ProcessJobOptions } from "./process-types.js";
import { materializeGitSource } from "./source-materialize.js";

export async function handleImportSourceJob(
  store: ImportSourceStore,
  job: Job<"import_source">,
  options: ProcessJobOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  const project = await store.getProject(job.projectId);
  options.signal?.throwIfAborted();
  if (!project) {
    throw new Error(`Project ${job.projectId} not found.`);
  }

  const sourcePathFromPayload = job.payload.sourcePath ?? null;
  const gitCredential = job.payload.gitCredential ?? null;
  let sourcePath = sourcePathFromPayload;
  let commitSha: string | null = null;

  if (!sourcePath && project.importKind === "git") {
    const gitUrl = job.payload.gitUrl ?? project.gitUrl;
    if (!gitUrl) {
      throw new Error("Git import missing gitUrl.");
    }
    sourcePath = path.join(
      process.env.EVELAND_DATA_DIR ?? ".eveland-data",
      "sources",
      job.projectId,
      job.id,
      `attempt-${job.attempts}`,
    );
    commitSha = await materializeGitSource({
      gitUrl,
      targetDir: sourcePath,
      credential: gitCredential,
      appSecretKey: options.appSecretKey,
      ...(options.signal ? { signal: options.signal } : {}),
      onRetry: async (attempt, detail) => {
        options.signal?.throwIfAborted();
        await store.appendLog({
          projectId: job.projectId,
          type: "build",
          line: `Retrying repository fetch (attempt ${attempt}): ${detail}`,
        });
        options.signal?.throwIfAborted();
      },
    });
  }

  options.signal?.throwIfAborted();
  if (!sourcePath) {
    throw new Error("Source import missing sourcePath.");
  }

  const scan = await scanEveSource({
    kind: project.importKind,
    sourcePath,
    commitSha,
  });
  options.signal?.throwIfAborted();
  await store.recordSourceRevision({
    projectId: job.projectId,
    ...scan,
  });
  options.signal?.throwIfAborted();
  if (gitCredential?.persistAfterImport) {
    await store.upsertGitCredential(
      gitCredential.userId,
      gitCredential.host,
      gitCredential.encryptedToken,
    );
    options.signal?.throwIfAborted();
  }
  await store.appendLog({
    projectId: job.projectId,
    type: "build",
    line: `Source import completed for ${project.name}.`,
  });
  options.signal?.throwIfAborted();

  // A re-sync can opt into deploying the freshly imported source in one step;
  // enqueued only after a successful import so a failed pull never deploys.
  if (job.payload.deployAfterImport === true) {
    await store.enqueueJob(job.projectId, "build_deploy", {
      promoteAfterDeploy: job.payload.promoteAfterDeploy === true,
    });
    options.signal?.throwIfAborted();
    await store.appendLog({
      projectId: job.projectId,
      type: "build",
      line: `Queued deploy of the latest source for ${project.name}.`,
    });
    options.signal?.throwIfAborted();
  }
}
