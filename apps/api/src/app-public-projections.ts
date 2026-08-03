import type {
  DeploymentRecord,
  ReleaseRecord,
  Session,
  SourceRevision,
  TeamInvitation,
} from "@eveland/core/contracts";
import { invitationHandle } from "./auth.js";

// Control-plane responses cross the browser boundary. Strip runtime
// capability material (session continuation tokens) and host infrastructure
// detail (host source paths, container names, container-internal ports,
// registry image refs) before serialization; Gateway and Worker keep
// consuming the full records. app-response-redaction.test.ts is the ratchet.

export function publicSession<T extends Session>(session: T): Omit<T, "continuationToken"> {
  const { continuationToken: _continuationToken, ...rest } = session;
  return rest;
}

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
): Omit<T, "imageTag" | "observerContract"> {
  const { imageTag: _imageTag, observerContract: _observerContract, ...rest } = release;
  return rest;
}
