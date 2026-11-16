import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { VERIFIED_EVE_VERSION } from "@evelandhq/core/eve-compatibility";
import type { AgentRuntimePolicy } from "@evelandhq/core/observability";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  bundleObserverRuntimeEntry,
  createObserverInstrumentationShim,
  createObserverShim,
  injectExtensionSubagentHooks,
  injectObserverHooks,
} from "./injector.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const EVE_PACKAGE = path.join(packageRoot, "node_modules/eve");
const EVE_BIN = path.join(EVE_PACKAGE, "bin/eve.js");
// Vitest sets NODE_ENV=test, under which eve swaps authored models for mocks;
// the agent must run its own models the way a deployment does.
const eveEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  EVE_TELEMETRY_DISABLED: "1",
};
const TEST_POLICY_ENV = "EVELAND_OBSERVER_TEST_POLICY_PATH";

type LogRecord = { attributes: Record<string, string> };

/**
 * Builds and starts a real eve agent with the observer injected the way a
 * Release gets it -- a hook shim per hook slot (the root, a directory-form
 * subagent, and an installed Extension's subagent) plus the root
 * instrumentation shim -- with every shim loading the runtime from a
 * stand-in for the platform mount, and exports to a local OTLP receiver.
 */
describe("observer runtime on a running eve agent", () => {
  let workDir: string;
  let server: ChildProcess | undefined;
  let receiver: Server;
  let rootSessionId: string;
  const logs: LogRecord[] = [];

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), "eveland-observer-runtime-"));
    receiver = await startOtlpReceiver(logs);
    const otlpPort = (receiver.address() as AddressInfo).port;

    const extensionDir = path.join(workDir, "extension");
    await copyFixture("eve-observer-extension", extensionDir);
    await writeFile(
      path.join(extensionDir, "package.json"),
      `${JSON.stringify({
        name: "eveland-probe-extension",
        version: "0.0.0",
        private: true,
        type: "module",
        eve: { extension: { source: "./extension", dist: "./dist/extension" } },
        files: ["dist"],
        peerDependencies: { eve: "*" },
        devDependencies: { eve: VERIFIED_EVE_VERSION },
      })}\n`,
    );
    await linkEve(extensionDir);
    await execFileAsync(process.execPath, [EVE_BIN, "extension", "build"], {
      cwd: extensionDir,
      env: eveEnv,
    });

    const agentDir = path.join(workDir, "agent");
    await copyFixture("eve-observer", agentDir);
    await writeFile(
      path.join(agentDir, "package.json"),
      `${JSON.stringify({
        name: "eveland-observer-runtime-fixture",
        private: true,
        type: "module",
        dependencies: { eve: VERIFIED_EVE_VERSION, "eveland-probe-extension": "0.0.0" },
      })}\n`,
    );
    await linkEve(agentDir);
    const installedExtension = path.join(agentDir, "node_modules/eveland-probe-extension");
    await mkdir(installedExtension, { recursive: true });
    await cp(
      path.join(extensionDir, "package.json"),
      path.join(installedExtension, "package.json"),
    );
    await cp(path.join(extensionDir, "dist"), path.join(installedExtension, "dist"), {
      recursive: true,
    });

    // The stand-in mount: the runtime bundle reads its policy from here.
    const mountDir = path.join(workDir, "mount");
    await mkdir(mountDir);
    const policyPath = path.join(mountDir, "agent-policy.json");
    await writeFile(policyPath, JSON.stringify(policy(`http://127.0.0.1:${String(otlpPort)}`)));
    // The test entry reads the policy path from the agent's environment.
    eveEnv[TEST_POLICY_ENV] = policyPath;
    const entryPath = path.join(packageRoot, "fixtures/eve-observer-runtime-entry.ts");
    const mountedRuntime = path.join(mountDir, "runtime.mjs");
    const mountUrl = pathToFileURL(mountedRuntime).href;

    // Inject as the Worker does: the release tree first, then the Extension
    // subagents the discovery manifest names once dependencies are installed.
    const injected = await injectObserverHooks({ releaseDir: agentDir });
    const { stdout: info } = await execFileAsync(process.execPath, [EVE_BIN, "info", "--json"], {
      cwd: agentDir,
      env: eveEnv,
    });
    const manifestPath = (
      JSON.parse(info.slice(info.indexOf("{"))) as { artifacts: { discoveryManifest: string } }
    ).artifacts.discoveryManifest;
    const extension = await injectExtensionSubagentHooks({
      releaseDir: agentDir,
      manifest: JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    });
    expect(extension.injectedFiles).toEqual([
      "node_modules/eveland-probe-extension/dist/extension/subagents/helper/hooks/eveland-observer.js",
    ]);
    // Point every shim at the stand-in mount; the shim generators are the ones
    // injection used.
    const bakedRuntime = path.join(agentDir, injected.runtimeFile!);
    for (const file of injected.injectedFiles) {
      const shimPath = path.join(agentDir, file);
      await writeFile(
        shimPath,
        file.includes("/instrumentation/")
          ? createObserverInstrumentationShim(shimPath, bakedRuntime, mountUrl)
          : createObserverShim(shimPath, bakedRuntime, mountUrl),
      );
    }
    for (const file of extension.injectedFiles) {
      const shimPath = path.join(agentDir, file);
      await writeFile(shimPath, createObserverShim(shimPath, undefined, mountUrl));
    }

    await execFileAsync(process.execPath, [EVE_BIN, "build"], {
      cwd: agentDir,
      env: eveEnv,
      maxBuffer: 64 * 1024 * 1024,
    });
    // The Worker mounts the runtime into the deployment, never into the build:
    // a runtime present at build time would be bundled into each shim.
    await writeFile(mountedRuntime, await bundleObserverRuntimeEntry(entryPath));
    const port = await freePort();
    server = spawn(
      process.execPath,
      [EVE_BIN, "start", "--host", "127.0.0.1", "--port", String(port)],
      { cwd: agentDir, env: eveEnv, detached: true, stdio: "ignore" },
    );
    const base = `http://127.0.0.1:${String(port)}`;
    await waitFor(async () => (await fetch(`${base}/eve/v1/health`).catch(() => null))?.ok);
    const created = (await (
      await fetch(`${base}/eve/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "go" }),
      })
    ).json()) as { sessionId: string };
    rootSessionId = created.sessionId;
    await waitFor(
      () =>
        new Set(
          usageLogs(logs)
            .filter((log) => log.attributes["eveland.gen_ai.observed.model"])
            .map((log) => log.attributes["eveland.eve.session.id"]),
        ).size >= 3,
    ).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Received ${JSON.stringify(
          logs.map((log) =>
            [
              log.attributes["eveland.eve.session.id"]?.slice(-6),
              log.attributes["eveland.eve.event.type"],
              log.attributes["eveland.eve.run.id"],
              log.attributes["eveland.gen_ai.observed.model"],
            ].join(" "),
          ),
        )}`,
      );
    });
  }, 240_000);

  afterAll(async () => {
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await new Promise<void>((resolve) => receiver?.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  test("labels each session's usage with the model its provider call ran", () => {
    const observed = new Map<string, Set<string>>();
    for (const log of usageLogs(logs)) {
      const sessionId = log.attributes["eveland.eve.session.id"]!;
      const model = log.attributes["eveland.gen_ai.observed.model"];
      if (!model) continue;
      observed.set(sessionId, (observed.get(sessionId) ?? new Set()).add(model));
    }

    // The root selects `fixture/root-requested`; its provider ran `served-root`.
    expect([...(observed.get(rootSessionId) ?? [])]).toEqual(["served-root"]);
    const children = [...observed.entries()]
      .filter(([sessionId]) => sessionId !== rootSessionId)
      .map(([, models]) => [...models])
      .sort();
    // A directory-form subagent and an Extension subagent: each child
    // session's runs carry that child's own model, not the root's.
    expect(children).toEqual([["dirchild-model"], ["ext-helper-model"]]);
  });

  test("links each child session to the root that delegated to it", () => {
    const parents = new Set(
      usageLogs(logs)
        .filter((log) => log.attributes["eveland.eve.session.id"] !== rootSessionId)
        .map((log) => log.attributes["eveland.eve.parent_session.id"]),
    );
    expect([...parents]).toEqual([rootSessionId]);
  });
});

function usageLogs(logs: LogRecord[]): LogRecord[] {
  return logs.filter((log) => log.attributes["eveland.eve.event.type"] === "usage.recorded");
}

async function copyFixture(name: string, target: string): Promise<void> {
  await cp(path.join(packageRoot, "fixtures", name), target, { recursive: true });
}

async function linkEve(projectDir: string): Promise<void> {
  await mkdir(path.join(projectDir, "node_modules"), { recursive: true });
  await symlink(EVE_PACKAGE, path.join(projectDir, "node_modules/eve"), "dir");
}

function policy(endpoint: string): AgentRuntimePolicy {
  return {
    schemaVersion: 1,
    revision: 1,
    capture: { enabled: true, sampleRatio: 1, recordInputs: false, recordOutputs: false },
    deploymentCredential: "credential.signature",
    otlp: { endpoint },
    resource: {
      teamId: "team_1",
      projectId: "proj_1",
      releaseId: "rel_1",
      deploymentId: "dep_1",
      runtimeKind: "systemd",
      environment: "production",
    },
  };
}

/** Collects the attributes of every OTLP/HTTP JSON log record posted to `/v1/logs`. */
async function startOtlpReceiver(logs: LogRecord[]): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/v1/logs") {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            resourceLogs?: Array<{
              scopeLogs?: Array<{
                logRecords?: Array<{
                  attributes?: Array<{ key: string; value: { stringValue?: string } }>;
                }>;
              }>;
            }>;
          };
          for (const resource of payload.resourceLogs ?? []) {
            for (const scope of resource.scopeLogs ?? []) {
              for (const record of scope.logRecords ?? []) {
                const attributes: Record<string, string> = {};
                for (const { key, value } of record.attributes ?? []) {
                  if (value.stringValue !== undefined) attributes[key] = value.stringValue;
                }
                logs.push({ attributes });
              }
            }
          }
        } catch {
          // Not a JSON payload; the assertions report what is missing.
        }
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor(check: () => unknown, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the running agent.");
}
