import type {
  DeploymentRecord,
  ReleaseRecord,
  SourceRevision,
  TeamInvitation,
} from "@evelandhq/core/contracts";
import { invitationHandle } from "./auth.js";

// Control-plane responses cross the browser boundary. Strip host
// infrastructure detail (host source paths, container names,
// container-internal ports, registry image refs) before serialization;
// Gateway and Worker keep consuming the full records.
// app-response-redaction.test.ts is the ratchet.

// The Better Auth invitation row id IS the single-use acceptance token, so
// serialized invitations swap it for a derived management handle. The raw
// token leaves the API only inside create/resend inviteUrl.
export function publicInvitation(invitation: TeamInvitation): TeamInvitation {
  return { ...invitation, id: invitationHandle(invitation.id) };
}

export function publicSourceRevision<T extends SourceRevision>(revision: T): Omit<T, "sourcePath"> {
  const { sourcePath: _sourcePath, ...rest } = revision;
  return rest;
}

// hostPort stays: the deployments page shows it as the loopback upstream.
export function publicDeployment<T extends DeploymentRecord>(
  deployment: T,
): Omit<T, "containerName" | "internalPort"> {
  const { containerName: _containerName, internalPort: _internalPort, ...rest } = deployment;
  return rest;
}

export function publicRelease<T extends ReleaseRecord>(
  release: T,
): Omit<T, "imageTag" | "observerContract" | "workflow"> {
  const {
    imageTag: _imageTag,
    observerContract: _observerContract,
    workflow: _workflow,
    ...rest
  } = release;
  return rest;
}
