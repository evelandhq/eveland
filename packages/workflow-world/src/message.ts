import { MessageId } from "@workflow/world";
import { z } from "zod/v4";
import { Base64Buffer } from "./zod.js";

/**
 * graphile-worker is using JSON under the hood, so we need to base64 encode
 * the body to ensure binary safety
 * maybe later we can have a `blobs` table for larger payloads
 *
 * `tenantId` and `deploymentId` are Eveland additions. The dispatcher reads
 * both straight off the job: the tenant to scope its storage reads, the
 * deployment as the affinity hint for which agent should execute the step. The
 * run row stays authoritative for affinity — these are what let the dispatcher
 * find that row at all, without deserializing the vqs body. Ids only, never
 * state.
 */
export const MessageData = z.object({
  attempt: z.number().describe("The attempt number of the message"),
  messageId: MessageId.describe("The unique ID of the message"),
  idempotencyKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  id: z
    .string()
    .describe(
      "The ID of the sub-queue. For workflows, it's the workflow name. For steps, it's the step name.",
    ),
  data: Base64Buffer.describe("The message that was sent"),
  tenantId: z.string().describe("Eveland project id that owns this message"),
  deploymentId: z
    .string()
    .describe("Deployment that enqueued the message; the dispatcher's affinity hint"),
});
export type MessageData = z.infer<typeof MessageData>;
