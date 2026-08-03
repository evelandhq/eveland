import { once } from "node:events";
import { createServer } from "node:http";

type Signal = "traces" | "logs" | "metrics";

export async function startOtlpTestReceiver(port = 4328) {
  const received: Record<Signal, Array<Record<string, unknown>>> = {
    traces: [],
    logs: [],
    metrics: [],
  };
  const server = createServer(async (request, response) => {
    const signal = signalFromPath(request.url);
    if (request.method !== "POST" || !signal) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      received[signal].push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(port, "127.0.0.1");
  if (!server.listening) await once(server, "listening");

  return {
    drain(signal: Signal) {
      return received[signal].splice(0);
    },
    count(signal: Signal) {
      return received[signal].length;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function signalFromPath(url: string | undefined): Signal | null {
  if (url === "/v1/traces") return "traces";
  if (url === "/v1/logs") return "logs";
  if (url === "/v1/metrics") return "metrics";
  return null;
}
