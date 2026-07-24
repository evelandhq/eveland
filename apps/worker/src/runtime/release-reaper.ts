import type { Store } from "@eveland/db";

export async function sweepReleaseRetention(
  store: Store,
  input: {
    keepRecent?: number;
    limit?: number;
  } = {},
): Promise<number> {
  const configuredKeepRecent = input.keepRecent ?? 3;
  const keepRecent = Number.isFinite(configuredKeepRecent)
    ? Math.max(3, Math.floor(configuredKeepRecent))
    : 3;
  const configuredLimit = input.limit ?? 25;
  const limit = Number.isFinite(configuredLimit)
    ? Math.max(1, Math.floor(configuredLimit))
    : 25;
  let enqueued = 0;

  for (const project of await store.listProjects()) {
    if (project.deletionStatus === "deleting") continue;
    const retention = await store.getDeploymentRetention(
      project.id,
      keepRecent,
    );
    for (const entry of retention) {
      if (
        enqueued >= limit ||
        entry.protected ||
        entry.deployment.status !== "stopped"
      ) {
        continue;
      }
      const result = await store.enqueueDeploymentArchive(
        project.id,
        entry.deployment.id,
        { automatic: true },
      );
      if (result.created) enqueued += 1;
    }
    if (enqueued >= limit) break;
  }

  return enqueued;
}
