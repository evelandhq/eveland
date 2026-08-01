import { createEveVersionInfo, unsupportedEveVersionMessage } from "@eveland/core/source";
import { classifyEveSessionRequest } from "@eveland/core/eve";
import type { GatewayActivationClient, GatewayRepository } from "./gateway-types.js";

// Response and activation-lease lifecycle shared by the public catch-all and
// the privileged Playground proxy: the terminal responses both must produce,
// and the lease renewal/release tied to the upstream response stream.

export function sessionExpiredResponse(): Response {
  return Response.json(
    { error: "Session expired", code: "session_expired" },
    { status: 410 },
  );
}

export async function unsupportedDeploymentResponse(
  repository: GatewayRepository,
  deploymentId: string,
): Promise<Response | null> {
  const eveVersion = await repository.getDeploymentEveVersion(deploymentId) ?? createEveVersionInfo(null, null);
  if (eveVersion.supported) return null;
  return Response.json({
    error: "Unsupported Eve version",
    detail: unsupportedEveVersionMessage(eveVersion.version),
    eveVersion,
  }, { status: 409 });
}

export function activationKind(method: string, pathname: string): "public_request" | "stream" | "turn" {
  const request = classifyEveSessionRequest(method, pathname);
  if (request?.kind === "stream") return "stream";
  if (request) return "turn";
  return "public_request";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function cancelUpstreamAndReleaseActivation(
  upstream: Response,
  error: unknown,
  activation: { leaseId: string } | null,
  client: GatewayActivationClient | undefined,
): Promise<void> {
  await upstream.body?.cancel(error).catch(() => undefined);
  if (activation && client) {
    await client.release(activation.leaseId).catch(() => undefined);
  }
}

export function manageActivationResponse(
  response: Response,
  client: GatewayActivationClient,
  leaseId: string,
  renewIntervalMs: number,
): Response {
  if (!response.body) {
    void client.release(leaseId).catch(() => undefined);
    return response;
  }
  const reader = response.body.getReader();
  let finalized = false;
  const renewTimer = setInterval(() => {
    void client.renew(leaseId).catch(() => undefined);
  }, renewIntervalMs);
  renewTimer.unref?.();
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    clearInterval(renewTimer);
    await client.release(leaseId).catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await finalize();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        await finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finalize();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
