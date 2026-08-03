import {
  externalDestinationConfigSchema,
  langfuseOtlpTracesEndpoint,
  type ExternalDestinationConfig,
  type ObservabilitySignal,
} from "../observability.js";
import { decryptSecretValue, encryptSecretValue, type EncryptedSecret } from "./secrets.js";
import type { LookupAddress } from "node:dns";
import { lookup as defaultLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const destinationResponseLimitBytes = 1024 * 1024;
const defaultDestinationTimeoutMs = 10_000;

export type ExternalObservabilityResponse = {
  status: number;
  contentType: string | null;
  body: Uint8Array;
};

export type ExternalObservabilityRequestInput = {
  config: ExternalDestinationConfig;
  signal: ObservabilitySignal;
  contentType: string;
  body: Uint8Array;
  privateHostAllowlist?: ReadonlySet<string>;
  lookup?: DestinationLookup;
  timeoutMs?: number;
};

type DestinationLookup = (hostname: string) => Promise<LookupAddress[]>;

type DestinationNetworkOptions = {
  privateHostAllowlist?: ReadonlySet<string>;
  lookup?: DestinationLookup;
};

const blockedIpv4DestinationAddresses = createBlockedIpv4DestinationAddresses();
const blockedIpv6DestinationAddresses = createBlockedIpv6DestinationAddresses();

/**
 * A destination configuration is stored as one sealed blob so that adding a credential
 * field never widens the plaintext surface. API and Worker share this pair: the API seals
 * what the Admin submits, the Worker opens it to render Collector exporters and to probe
 * destination health.
 */
export function encryptDestinationConfig(
  config: ExternalDestinationConfig,
  appSecretKey: string,
): string {
  return JSON.stringify(encryptSecretValue(JSON.stringify(config), appSecretKey));
}

export function decryptDestinationConfig(
  encryptedConfig: string,
  appSecretKey: string,
): ExternalDestinationConfig {
  try {
    const encrypted = JSON.parse(encryptedConfig) as EncryptedSecret;
    return externalDestinationConfigSchema.parse(
      JSON.parse(decryptSecretValue(encrypted, appSecretKey)),
    );
  } catch {
    throw new Error("Could not decrypt an observability destination.");
  }
}

export function parseObservabilityPrivateHostAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map(normalizeHostname)
      .filter((hostname) => hostname.length > 0),
  );
}

export async function validateExternalObservabilityDestination(
  config: ExternalDestinationConfig,
  options: DestinationNetworkOptions = {},
): Promise<void> {
  for (const signal of destinationSignals(config)) {
    const request = destinationSignalRequest(config, signal);
    await resolveSafeDestination(request.url, options);
  }
}

export async function requestExternalObservabilityDestination(
  input: ExternalObservabilityRequestInput,
): Promise<ExternalObservabilityResponse> {
  const destination = destinationSignalRequest(input.config, input.signal);
  const resolved = await resolveSafeDestination(destination.url, input);
  const requestImplementation = destination.url.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    if ("all" in _options && _options.all) {
      callback(null, [resolved]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };

  return new Promise((resolve, reject) => {
    const request = requestImplementation(destination.url, {
      method: "POST",
      headers: {
        ...destination.headers,
        "content-type": input.contentType,
        "content-length": String(input.body.byteLength),
      },
      lookup,
    });
    request.setTimeout(input.timeoutMs ?? defaultDestinationTimeoutMs, () =>
      request.destroy(new Error("Destination request timed out.")),
    );
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > destinationResponseLimitBytes) {
          response.destroy(new Error("Destination response is too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 502,
          contentType:
            typeof response.headers["content-type"] === "string"
              ? response.headers["content-type"]
              : null,
          body: new Uint8Array(Buffer.concat(chunks)),
        });
      });
    });
    request.end(input.body);
  });
}

function destinationSignals(config: ExternalDestinationConfig): readonly ObservabilitySignal[] {
  if (config.kind === "langfuse") return ["traces"];
  if (config.kind === "custom_otlp") return config.supportedSignals;
  return ["traces", "logs", "metrics"];
}

function destinationSignalRequest(
  config: ExternalDestinationConfig,
  signal: ObservabilitySignal,
): { url: URL; headers: Record<string, string> } {
  if (!destinationSignals(config).includes(signal)) {
    throw new Error(`Destination does not support ${signal} telemetry.`);
  }
  if (config.kind === "langfuse") {
    return {
      url: new URL(langfuseOtlpTracesEndpoint(config.baseUrl)),
      headers: {
        authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString(
          "base64",
        )}`,
        "x-langfuse-ingestion-version": "4",
      },
    };
  }
  const endpoint = `${config.endpoint.replace(/\/+$/, "")}/v1/${signal}`;
  if (config.kind === "elastic") {
    return {
      url: new URL(endpoint),
      headers: {
        authorization: `${
          config.authorization.type === "api_key" ? "ApiKey" : "Bearer"
        } ${config.authorization.value}`,
      },
    };
  }
  return { url: new URL(endpoint), headers: config.headers };
}

async function resolveSafeDestination(
  url: URL,
  options: DestinationNetworkOptions,
): Promise<LookupAddress> {
  const hostname = normalizeHostname(url.hostname);
  const allowlisted = options.privateHostAllowlist?.has(hostname) ?? false;
  if (!allowlisted && url.protocol !== "https:") {
    throw new Error(
      "External observability destinations must use HTTPS unless their host is explicitly allowlisted.",
    );
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await (options.lookup ?? lookupAll)(hostname);
  if (addresses.length === 0) {
    throw new Error("Destination hostname did not resolve.");
  }
  if (!allowlisted && addresses.some((address) => !isPublicAddress(address))) {
    throw new Error("Destination must resolve only to public IP addresses.");
  }
  return addresses[0]!;
}

async function lookupAll(hostname: string): Promise<LookupAddress[]> {
  return defaultLookup(hostname, { all: true, verbatim: true });
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isPublicAddress(address: LookupAddress): boolean {
  return address.family === 6
    ? !blockedIpv6DestinationAddresses.check(address.address, "ipv6")
    : !blockedIpv4DestinationAddresses.check(address.address, "ipv4");
}

function createBlockedIpv4DestinationAddresses(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  return list;
}

function createBlockedIpv6DestinationAddresses(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}
