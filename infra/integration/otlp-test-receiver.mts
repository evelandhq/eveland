import { once } from "node:events";
import { createServer } from "node:http";
import { OTEL_AGENT_HOST_HTTP_PORT } from "../../packages/core/src/ports.js";

type Signal = "traces" | "logs" | "metrics";

export async function startOtlpTestReceiver(port = OTEL_AGENT_HOST_HTTP_PORT) {
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
  if (!server.listening) {
    // Race the two outcomes. Awaiting "listening" alone never settles when the
    // bind fails, and the unhandled "error" event then takes the process down
    // with a bare EADDRINUSE that says nothing about why this port matters.
    const [error] = (await Promise.race([
      once(server, "listening").then(() => [null] as const),
      once(server, "error"),
    ])) as [NodeJS.ErrnoException | null];
    if (error) throw describeBindFailure(error, port);
  }

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

/**
 * The Agent under test dials the Agent receiver on a fixed loopback address, so
 * this stand-in has to own that exact port -- it cannot fall back to an
 * ephemeral one the way every other server in these suites does. The usual
 * squatter is a real Collector: a leftover Compose stack in the Lima VM, or a
 * platform runtime someone left up on the host.
 */
function describeBindFailure(error: NodeJS.ErrnoException, port: number): Error {
  if (error.code !== "EADDRINUSE") return error;
  return new Error(
    `The OTLP test receiver could not bind 127.0.0.1:${port}, which the Agent under test dials directly. ` +
      "Something else already owns it -- usually a managed OTel Collector still running from an earlier " +
      "session (in the Lima VM: `sudo docker stop eveland-otel-collector`). Free the port and re-run.",
    { cause: error },
  );
}

function signalFromPath(url: string | undefined): Signal | null {
  if (url === "/v1/traces") return "traces";
  if (url === "/v1/logs") return "logs";
  if (url === "/v1/metrics") return "metrics";
  return null;
}
