import type { Job } from "@evelandhq/core/contracts";
import type { Store } from "@evelandhq/db";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type IdentityDeploymentConfiguration = {
  dataDir: string;
  issuer: string;
  jwksUrl: string;
};

export function resolveIdentityDeploymentConfiguration(input: {
  dataDir: string;
  nodeEnv?: string;
  issuer?: string;
  jwksUrl?: string;
}): IdentityDeploymentConfiguration | null {
  const isProduction = input.nodeEnv === "production";
  const issuer = input.issuer || (!isProduction ? "http://localhost:4000" : undefined);
  if (!issuer) return null;
  const normalizedIssuer = issuer.replace(/\/$/, "");
  const jwksUrl =
    input.jwksUrl ||
    (!isProduction && normalizedIssuer === "http://localhost:4000"
      ? "http://host.docker.internal:4000/.well-known/jwks.json"
      : `${normalizedIssuer}/.well-known/jwks.json`);
  return {
    dataDir: input.dataDir,
    issuer: normalizedIssuer,
    jwksUrl,
  };
}

export async function reconcileIdentityDeploymentConfiguration(
  store: Store,
  configuration: IdentityDeploymentConfiguration,
): Promise<Job[]> {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        issuer: configuration.issuer.replace(/\/$/, ""),
        jwksUrl: configuration.jwksUrl,
      }),
    )
    .digest("hex");
  const stateDir = path.join(configuration.dataDir, "runtime-state");
  const statePath = path.join(stateDir, "identity-configuration.sha256");
  const previous = await readFile(statePath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (previous.trim() === fingerprint) return [];

  const jobs: Job[] = [];
  for (const project of await store.listProjects()) {
    const deployments = await store.listDeployments(project.id);
    for (const deployment of deployments) {
      if (deployment.status !== "running" && deployment.status !== "draining") {
        continue;
      }
      jobs.push(
        await store.enqueueJob(project.id, "restart_deployment", {
          deploymentId: deployment.id,
          reason: "identity_configuration_changed",
        }),
      );
    }
  }

  await mkdir(stateDir, { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${fingerprint}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);
  return jobs;
}
