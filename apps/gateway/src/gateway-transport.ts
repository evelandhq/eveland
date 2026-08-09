import http from "node:http";
import { Readable } from "node:stream";
import { DownstreamAbortedError, RequestBodyTooLargeError } from "./gateway-routing.js";

// Raw loopback HTTP transport: socket handling, hop-by-hop hygiene, body
// limits, and abort propagation. No routing or session semantics here.

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function proxyToDeployment(input: {
  port: number;
  path: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  timeoutMs?: number;
  /**
   * How an idle timeout surfaces once the response is streaming: "abort"
   * errors the body (default); "end" closes it as a normal end of stream, so
   * every proxy hop and the client observe a clean chunked terminator.
   * Session streams use "end" -- silence between turns is legitimate there,
   * and an abort that an intermediary fails to propagate leaves the client
   * holding a dead connection. Before response headers arrive both modes
   * fail the request.
   */
  idleTimeoutMode?: "abort" | "end";
  signal?: AbortSignal;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const idleEnd = { requested: false };
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method,
        headers: Object.fromEntries(input.headers.entries()),
      },
      (response) => {
        responseStarted = true;
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name && value !== undefined && !hopByHopHeaders.has(name.toLowerCase()))
            headers.append(name, value);
        }
        resolve(
          new Response(proxyResponseBody(response, request, idleEnd), {
            status: response.statusCode ?? 502,
            statusText: response.statusMessage,
            headers,
          }),
        );
      },
    );
    const abort = () => request.destroy(new DownstreamAbortedError());
    const cleanup = () => input.signal?.removeEventListener("abort", abort);
    request.once("error", (error) => {
      cleanup();
      if (!responseStarted) reject(error);
    });
    request.once("close", cleanup);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    if (input.timeoutMs)
      request.setTimeout(input.timeoutMs, () => {
        if (input.idleTimeoutMode === "end" && responseStarted) {
          idleEnd.requested = true;
          request.destroy();
        } else {
          request.destroy(new Error("Upstream request timed out."));
        }
      });
    request.end(input.body ?? undefined);
  });
}

export async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DownstreamAbortedError();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body limit exceeded").catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function proxyResponseBody(
  response: http.IncomingMessage,
  request: http.ClientRequest,
  idleEnd: { requested: boolean },
): ReadableStream<Uint8Array> {
  const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        if (idleEnd.requested) controller.close();
        else controller.error(error);
      }
    },
    async cancel(reason) {
      response.destroy();
      request.destroy();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

const HEARTBEAT_CHUNK = new TextEncoder().encode("\n");

/**
 * Re-emit `source` unchanged, inserting a bare newline whenever `heartbeatMs`
 * elapses without an upstream chunk. NDJSON consumers skip blank lines, so
 * the heartbeat is invisible to eve clients while keeping intermediaries
 * (undici body timeouts, reverse-proxy read timeouts) from reaping a silent
 * but healthy session stream. Pull-based: buffers at most one upstream read.
 */
export function withNdjsonIdleHeartbeat(
  source: ReadableStream<Uint8Array>,
  heartbeatMs: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      pending ??= reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const heartbeat = new Promise<"heartbeat">((resolve) => {
        timer = setTimeout(() => resolve("heartbeat"), heartbeatMs);
      });
      try {
        const winner = await Promise.race([pending, heartbeat]);
        if (winner === "heartbeat") {
          controller.enqueue(HEARTBEAT_CHUNK);
          return;
        }
        pending = null;
        if (winner.done) controller.close();
        else controller.enqueue(winner.value);
      } catch (error) {
        pending = null;
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
