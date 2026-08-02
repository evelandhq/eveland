import { decryptSecretValue } from "@eveland/core/server/secrets";

import { getGitCommitSha, importGitSource } from "../source/importer.js";
import { devSecretKey, parseEncryptedSecret } from "./process-support.js";

/**
 * Materialize a git working copy and resolve its commit: the one place that
 * decrypts a per-request git credential and threads abort/retry into the
 * fetch. Both the import_source handler and the source-preflight pipeline go
 * through here so credential, abort, and retry behavior cannot drift between
 * them.
 */
export async function materializeGitSource(input: {
  gitUrl: string;
  targetDir: string;
  credential?: { host: string; encryptedToken: string } | null;
  appSecretKey?: string | undefined;
  signal?: AbortSignal | undefined;
  onRetry?: (attempt: number, detail: string) => Promise<void>;
}): Promise<string | null> {
  await importGitSource({
    gitUrl: input.gitUrl,
    targetDir: input.targetDir,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.credential
      ? {
          credential: {
            host: input.credential.host,
            token: decryptSecretValue(
              parseEncryptedSecret(input.credential.encryptedToken),
              input.appSecretKey ?? process.env.APP_SECRET_KEY ?? devSecretKey,
            ),
          },
        }
      : {}),
    ...(input.onRetry ? { onRetry: input.onRetry } : {}),
  });
  return getGitCommitSha(input.targetDir, input.signal);
}
