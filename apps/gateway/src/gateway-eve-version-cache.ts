import type { EveVersionInfo } from "@evelandhq/core/source";

type DeploymentEveVersionSource = {
  getDeploymentEveVersion(deploymentId: string): Promise<EveVersionInfo | null>;
};

/**
 * Memoizes `getDeploymentEveVersion` per Deployment for the process lifetime.
 *
 * A Deployment's Eve version derives from its immutable Source Revision, and
 * the supported-window policy is baked into the running binary, so a resolved
 * `EveVersionInfo` can never change for a given deployment id. The version
 * gate runs on every public Gateway request, which without this cache costs
 * one three-way join per request.
 *
 * The in-flight promise is what gets cached, so concurrent requests for the
 * same Deployment share a single lookup. Two results are deliberately NOT
 * retained: `null` (unknown deployment id — not a conclusion about a version)
 * and rejections, so a later request retries instead of pinning a transient
 * failure. Entries are evicted oldest-first past `maxEntries`, mirroring the
 * route cache's bounded-Map policy.
 */
export function withDeploymentEveVersionCache<T extends DeploymentEveVersionSource>(
  repository: T,
  options: { maxEntries?: number } = {},
): T {
  const maxEntries = options.maxEntries ?? 1024;
  const entries = new Map<string, Promise<EveVersionInfo | null>>();
  const lookup = repository.getDeploymentEveVersion.bind(repository);

  const getDeploymentEveVersion = (deploymentId: string): Promise<EveVersionInfo | null> => {
    const hit = entries.get(deploymentId);
    if (hit) return hit;
    const pending = lookup(deploymentId).then((info) => {
      if (info === null) entries.delete(deploymentId);
      return info;
    });
    pending.catch(() => entries.delete(deploymentId));
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    entries.set(deploymentId, pending);
    return pending;
  };

  return { ...repository, getDeploymentEveVersion };
}
