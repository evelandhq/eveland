import http from "node:http";
import { Readable } from "node:stream";
import {
  DownstreamAbortedError,
  RequestBodyTooLargeError,
} from "./gateway-routing.js";

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
  signal?: AbortSignal;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
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
          if (name && value !== undefined && !hopByHopHeaders.has(name.toLowerCase())) headers.append(name, value);
        }
        resolve(
          new Response(proxyResponseBody(response, request), {
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
    if (input.timeoutMs) request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Upstream request timed out.")));
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

function proxyResponseBody(response: http.IncomingMessage, request: http.ClientRequest): ReadableStream<Uint8Array> {
  const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      response.destroy();
      request.destroy();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
