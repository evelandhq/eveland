import { createHash, randomBytes } from "node:crypto";

/**
 * Model Gateway runtime tokens (`AI_GATEWAY_API_KEY` inside a deployment) are
 * bound to one RuntimeInstance: minted by the Worker at every process start,
 * stored server-side only as this hash on the instance row, and implicitly
 * revoked when the instance leaves the live statuses — a stopped process
 * leaves no usable credential behind.
 */
export function mintModelGatewayToken(): string {
  return `emg_${randomBytes(32).toString("base64url")}`;
}

export function hashModelGatewayToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
