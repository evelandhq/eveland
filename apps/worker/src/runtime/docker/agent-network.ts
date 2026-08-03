import { execa } from "execa";
import { createHash } from "node:crypto";

const defaultCollectorContainerName = "eveland-otel-collector";
const agentTelemetryCollectorAlias = "eveland-otel-collector";
const agentTelemetryNetworkLabel = "com.eveland.managed=agent-telemetry";
const agentTelemetryProcessLabel = "com.eveland.process";

export type ManagedAgentTelemetryNetwork = {
  name: string;
  processName: string;
};

export function resolveAgentTelemetryNetworkName(processName: string): string {
  const digest = createHash("sha256").update(processName).digest("hex").slice(0, 24);
  return `eveland-agent-${digest}`;
}

export async function ensureAgentTelemetryNetwork(
  processName: string,
  collectorContainerName = defaultCollectorContainerName,
): Promise<void> {
  const networkName = resolveAgentTelemetryNetworkName(processName);
  const inspect = await execa("docker", ["network", "inspect", networkName], {
    all: true,
    reject: false,
  });
  if (inspect.failed) {
    if (!/No such network|not found/i.test(inspect.all ?? "")) {
      throw new Error(
        `Could not inspect Docker network "${networkName}": ${
          inspect.all?.trim() || "docker network inspect failed"
        }`,
      );
    }
    const create = await execa(
      "docker",
      [
        "network",
        "create",
        "--label",
        agentTelemetryNetworkLabel,
        "--label",
        `${agentTelemetryProcessLabel}=${processName}`,
        networkName,
      ],
      { all: true, reject: false },
    );
    if (create.failed && !/already exists/i.test(create.all ?? "")) {
      throw new Error(
        `Could not create Docker network "${networkName}": ${
          create.all?.trim() || "docker network create failed"
        }. If Docker reports that all predefined address pools are subnetted, configure a larger default-address-pools range as documented in docs/deploy/linux.md.`,
      );
    }
  }

  await connectCollectorToAgentNetwork(networkName, collectorContainerName, true);
}

export async function removeAgentTelemetryNetwork(
  processName: string,
  collectorContainerName = defaultCollectorContainerName,
): Promise<void> {
  await removeAgentTelemetryNetworkByName(
    resolveAgentTelemetryNetworkName(processName),
    collectorContainerName,
  );
}

export async function listManagedAgentTelemetryNetworks(): Promise<ManagedAgentTelemetryNetwork[]> {
  const list = await execa(
    "docker",
    [
      "network",
      "ls",
      "--filter",
      `label=${agentTelemetryNetworkLabel}`,
      "--format",
      `{{.Name}}\t{{.Label "${agentTelemetryProcessLabel}"}}`,
    ],
    { all: true, reject: false },
  );
  if (list.failed) {
    throw new Error(
      `Could not list managed Agent telemetry networks: ${
        list.all?.trim() || "docker network ls failed"
      }`,
    );
  }
  return (list.stdout ?? "")
    .split("\n")
    .map((line) => {
      const [name, processName] = line.split("\t", 2);
      return {
        name: name?.trim() ?? "",
        processName: processName?.trim() ?? "",
      };
    })
    .filter(
      (network) =>
        network.name.length > 0 &&
        network.processName.length > 0 &&
        network.name === resolveAgentTelemetryNetworkName(network.processName),
    );
}

export function createAgentTelemetryNetworkReconciler(
  collectorContainerName = defaultCollectorContainerName,
): () => Promise<void> {
  let lastCollectorId: string | undefined;
  return async () => {
    const inspect = await execa(
      "docker",
      ["inspect", "--format", "{{.Id}}", collectorContainerName],
      { all: true, reject: false },
    );
    if (inspect.failed) {
      if (/No such (container|object)/i.test(inspect.all ?? "")) {
        lastCollectorId = undefined;
        return;
      }
      throw new Error(
        `Could not inspect Collector "${collectorContainerName}": ${
          inspect.all?.trim() || "docker inspect failed"
        }`,
      );
    }
    const collectorId = inspect.stdout?.trim();
    if (!collectorId) {
      throw new Error(
        `Docker returned no container identity for Collector "${collectorContainerName}".`,
      );
    }
    if (collectorId === lastCollectorId) return;

    const networks = await listManagedAgentTelemetryNetworks();
    for (const network of networks) {
      if (!(await dockerContainerExists(network.processName))) continue;
      const connected = await connectCollectorToAgentNetwork(network.name, collectorContainerName);
      if (!connected) return;
    }
    lastCollectorId = collectorId;
  };
}

export async function listOrphanAgentTelemetryNetworks(): Promise<ManagedAgentTelemetryNetwork[]> {
  const networks = await listManagedAgentTelemetryNetworks();
  const orphaned: ManagedAgentTelemetryNetwork[] = [];
  for (const network of networks) {
    if (!(await dockerContainerExists(network.processName))) {
      orphaned.push(network);
    }
  }
  return orphaned;
}

export async function removeOrphanAgentTelemetryNetwork(
  network: ManagedAgentTelemetryNetwork,
  collectorContainerName = defaultCollectorContainerName,
): Promise<boolean> {
  if (await dockerContainerExists(network.processName)) return false;
  await removeAgentTelemetryNetworkByName(network.name, collectorContainerName);
  return true;
}

async function connectCollectorToAgentNetwork(
  networkName: string,
  collectorContainerName: string,
  warnWhenCollectorMissing = false,
): Promise<boolean> {
  const connect = await execa(
    "docker",
    [
      "network",
      "connect",
      "--alias",
      agentTelemetryCollectorAlias,
      networkName,
      collectorContainerName,
    ],
    { all: true, reject: false },
  );
  if (connect.failed && /No such (container|object)/i.test(connect.all ?? "")) {
    if (warnWhenCollectorMissing) {
      console.warn(
        `OpenTelemetry Collector "${collectorContainerName}" is unavailable; Agent telemetry network "${networkName}" will be reconnected after the Collector returns.`,
      );
    }
    return false;
  }
  if (connect.failed && !/already exists in network|already connected/i.test(connect.all ?? "")) {
    throw new Error(
      `Could not connect Collector "${collectorContainerName}" to Docker network "${networkName}": ${
        connect.all?.trim() || "docker network connect failed"
      }`,
    );
  }
  return true;
}

async function dockerContainerExists(containerName: string): Promise<boolean> {
  const inspect = await execa("docker", ["inspect", "--type", "container", containerName], {
    all: true,
    reject: false,
  });
  if (!inspect.failed) return true;
  if (/No such (container|object)/i.test(inspect.all ?? "")) return false;
  throw new Error(
    `Could not inspect Docker container "${containerName}": ${
      inspect.all?.trim() || "docker inspect failed"
    }`,
  );
}

async function removeAgentTelemetryNetworkByName(
  networkName: string,
  collectorContainerName: string,
): Promise<void> {
  const disconnect = await execa(
    "docker",
    ["network", "disconnect", "--force", networkName, collectorContainerName],
    { all: true, reject: false },
  );
  if (
    disconnect.failed &&
    !/not connected|No such (container|network)|not found/i.test(disconnect.all ?? "")
  ) {
    throw new Error(
      `Could not disconnect Collector "${collectorContainerName}" from Docker network "${networkName}": ${
        disconnect.all?.trim() || "docker network disconnect failed"
      }`,
    );
  }
  const remove = await execa("docker", ["network", "rm", networkName], {
    all: true,
    reject: false,
  });
  if (remove.failed && !/No such network|not found/i.test(remove.all ?? "")) {
    throw new Error(
      `Could not remove Docker network "${networkName}": ${
        remove.all?.trim() || "docker network rm failed"
      }`,
    );
  }
}
