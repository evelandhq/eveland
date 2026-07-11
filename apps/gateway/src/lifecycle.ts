import type http from "node:http";
import type { Socket } from "node:net";
import type { RouteSource } from "./route-source.js";

export const DEFAULT_GATEWAY_SHUTDOWN_GRACE_MS = 5_000;

export type GatewayLifecycle = {
  trackSocket(socket: Socket): void;
  shutdown(): Promise<void>;
  activeSocketCount(): number;
};

export function createGatewayLifecycle(options: {
  server: http.Server;
  routeSource: RouteSource;
  shutdownGraceMs?: number;
  logger?: Pick<Console, "error" | "warn">;
}): GatewayLifecycle {
  const { server, routeSource, logger = console } = options;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_GATEWAY_SHUTDOWN_GRACE_MS;
  const sockets = new Set<Socket>();
  let shutdownPromise: Promise<void> | null = null;

  function trackSocket(socket: Socket): void {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  }

  server.on("connection", trackSocket);

  return {
    trackSocket,
    activeSocketCount() {
      return sockets.size;
    },
    shutdown() {
      shutdownPromise ??= shutdownServer({ server, routeSource, sockets, shutdownGraceMs, logger });
      return shutdownPromise;
    },
  };
}

async function shutdownServer(options: {
  server: http.Server;
  routeSource: RouteSource;
  sockets: Set<Socket>;
  shutdownGraceMs: number;
  logger: Pick<Console, "error" | "warn">;
}): Promise<void> {
  const { server, routeSource, sockets, shutdownGraceMs, logger } = options;
  let forced = false;

  const closeServer = new Promise<void>((resolve) => {
    server.close((error) => {
      if (error) {
        logger.error("Gateway server close failed during shutdown.", error);
      }
      resolve();
    });
  });

  const graceTimer = setTimeout(() => {
    forced = true;
    logger.warn(`Gateway shutdown grace period (${shutdownGraceMs}ms) expired; destroying ${sockets.size} active socket(s).`);
    for (const socket of sockets) {
      socket.destroy();
    }
  }, shutdownGraceMs);
  graceTimer.unref?.();

  await closeServer;
  clearTimeout(graceTimer);

  if (forced || sockets.size > 0) {
    for (const socket of sockets) {
      socket.destroy();
    }
  }
  await waitForTrackedSocketsToClose(sockets);

  try {
    await routeSource.close();
  } catch (error) {
    logger.error("Gateway route source close failed during shutdown.", error);
  }
}

async function waitForTrackedSocketsToClose(sockets: Set<Socket>): Promise<void> {
  const pending = [...sockets].filter((socket) => !socket.destroyed);
  await Promise.race([
    Promise.all(pending.map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())))),
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]);
  for (const socket of sockets) {
    if (socket.destroyed) {
      sockets.delete(socket);
    }
  }
}
