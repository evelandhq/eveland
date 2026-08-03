import net from "node:net";
import type { Store } from "@eveland/db";

export async function isTcpPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const cleanup = () => {
      server.removeAllListeners();
    };

    server.once("listening", () => {
      server.close((error) => {
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, host);
  });
}

/**
 * Ports this worker has allocated but not yet made DB-visible (a build_deploy
 * between allocation and recordDeployment). The DB reserved set and the TCP
 * probe are both blind in that window; this set closes it for the
 * single-worker production topology.
 */
const inFlightPorts = new Set<number>();

export function claimInFlightPort(port: number): void {
  inFlightPorts.add(port);
}

export function releaseInFlightPort(port: number): void {
  inFlightPorts.delete(port);
}

export async function allocateAvailableHostPort(
  startPort = Number(process.env.EVELAND_DEPLOYMENT_PORT ?? 41000),
  endPort = startPort + 100,
  reservedPorts: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let port = startPort; port <= endPort; port += 1) {
    if (reservedPorts.has(port) || inFlightPorts.has(port)) continue;
    if (await isTcpPortAvailable("127.0.0.1", port)) {
      return port;
    }
  }

  throw new Error(`No available deployment host port in range ${startPort}-${endPort}.`);
}

/**
 * Allocates a loopback port for a starting RuntimeInstance and persists the
 * claim to the row BEFORE anything binds it, so two live instances can never
 * hold the same port (enforced by the live-port unique index). A candidate
 * that fails the DB reservation belongs to another live instance -- try the
 * next one.
 */
export async function allocateReservedInstancePort(
  store: Pick<Store, "reserveRuntimeInstancePort">,
  runtimeInstanceId: string,
  input: {
    preferredPort?: number;
    startPort?: number;
    endPort?: number;
    dbReservedPorts?: ReadonlySet<number>;
  } = {},
): Promise<number> {
  const startPort = input.startPort ?? Number(process.env.EVELAND_DEPLOYMENT_PORT ?? 41000);
  const endPort = input.endPort ?? startPort + 100;
  const candidates: number[] = [];
  if (input.preferredPort !== undefined) candidates.push(input.preferredPort);
  for (let port = startPort; port <= endPort; port += 1) {
    if (port !== input.preferredPort) candidates.push(port);
  }
  for (const port of candidates) {
    // The preferred port is adopted even when something (our own still-running
    // unit) already listens on it; other candidates must probe free first.
    if (port !== input.preferredPort) {
      if (input.dbReservedPorts?.has(port) || inFlightPorts.has(port)) continue;
      if (!(await isTcpPortAvailable("127.0.0.1", port))) continue;
    }
    if (await store.reserveRuntimeInstancePort(runtimeInstanceId, port)) {
      return port;
    }
  }
  throw new Error(`No reservable deployment host port in range ${startPort}-${endPort}.`);
}
