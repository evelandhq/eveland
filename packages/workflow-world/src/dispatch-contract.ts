/**
 * The dispatcher→agent contract, shared by both ends so they cannot drift.
 *
 * Versioned explicitly, and actually checked. eve's own stream-version header
 * is sent but never validated; repeating that mistake here would mean a
 * dispatcher change could silently misbehave against an older bundled world
 * instead of failing with a clear error.
 *
 * Compatibility rule: a deployment accepts any version up to the newest it
 * knows. Within a major version the dispatcher may only *add* optional headers,
 * so old bundles keep working against a newer dispatcher — which is the
 * situation for the entire run-out, since a deployment's world is baked at
 * build time and never upgraded in place.
 */
export const DISPATCH_VERSION = 1;

export const DISPATCH_VERSION_HEADER = "x-eveland-dispatch-version";
export const RUNTIME_SECRET_HEADER = "x-eveland-runtime-secret";
export const TENANT_HEADER = "x-eveland-project-id";
export const DEPLOYMENT_HEADER = "x-eveland-deployment-id";
export const RUN_HEADER = "x-eveland-run-id";

/** vqs headers, owned by eve. Reproduced verbatim; changing them breaks dispatch. */
export const VQS_QUEUE_NAME_HEADER = "x-vqs-queue-name";
export const VQS_MESSAGE_ID_HEADER = "x-vqs-message-id";
export const VQS_MESSAGE_ATTEMPT_HEADER = "x-vqs-message-attempt";

/** Route segment for each queue kind, under `/.well-known/workflow/v1/`. */
export type DispatchRoute = "flow" | "step";

export type DispatchRejection = { status: number; error: string };

/**
 * Checked on the deployment side for every inbound dispatch.
 *
 * Requests carrying no version header at all are accepted: eve's own queue
 * handler is mounted on the same route and an embedded-mode world POSTs to it
 * over loopback without any Eveland headers. The check exists to reject a
 * *newer* dispatcher, not to make the header mandatory.
 */
export function checkDispatchVersion(
  headerValue: string | null | undefined,
  supported: number = DISPATCH_VERSION,
): DispatchRejection | undefined {
  if (headerValue === null || headerValue === undefined || headerValue === "") return undefined;
  const version = Number(headerValue);
  if (!Number.isInteger(version) || version <= 0) {
    return { status: 400, error: `Invalid ${DISPATCH_VERSION_HEADER}: ${headerValue}` };
  }
  if (version > supported) {
    return {
      status: 400,
      error:
        `This deployment's workflow world speaks dispatch version ${String(supported)}, ` +
        `but the dispatcher sent version ${String(version)}. Rebuild the deployment.`,
    };
  }
  return undefined;
}

/**
 * Constant-time-ish equality for the shared runtime secret. Length is allowed
 * to leak; the value is not.
 */
export function secretMatches(expected: string, received: string | null | undefined): boolean {
  if (!received || expected.length !== received.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return mismatch === 0;
}
