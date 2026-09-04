import { isPrivateBridgeIpv4 } from "@evelandhq/core/docker-bridge";
import type { ExecCommand } from "./io.ts";

/**
 * The host address the managed Collector reaches the host-native API at.
 *
 * The Collector is the last container in the Linux production form, and the
 * one hop that cannot use loopback: `host.docker.internal` resolves inside
 * that container to Docker's `host-gateway`, which is an address on the
 * host's default bridge, not the host's loopback. So the API binds that same
 * bridge address as a second, allowlisted listener.
 *
 * It is Docker's own configuration, not ours, and it changes when the daemon
 * renumbers its bridge (`bip`, a reinstall, a `docker network` reconfigure).
 * Every `start` re-detects it and rewrites the value rather than trusting one
 * written at install time — a stale address is a listener that fails to bind
 * and an Observation path that silently stops delivering.
 */
export const DOCKER_BRIDGE_GATEWAY_ARGV = [
  "docker",
  "network",
  "inspect",
  "bridge",
  "--format",
  "{{(index .IPAM.Config 0).Gateway}}",
];

/**
 * Docker's default-bridge gateway, or null when it cannot be determined (no
 * Docker, a daemon that reports no IPAM config, an address that is not a
 * private IPv4). Null is not an error here: the caller decides, and the API
 * simply runs without its second listener.
 */
export async function detectDockerBridgeHost(options: {
  execCommand: ExecCommand;
  cwd: string;
}): Promise<string | null> {
  const result = await options.execCommand(DOCKER_BRIDGE_GATEWAY_ARGV, { cwd: options.cwd });
  if (result.code !== 0) return null;
  // `--format` prints one line; anything else (an error page, a multi-network
  // inspect) is not an address and must not be written into a bind host.
  const host = result.output.trim();
  return isPrivateBridgeIpv4(host) ? host : null;
}
