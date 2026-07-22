import path from "node:path";
import open from "open";
import {
  beginDeviceLogin,
  deployProject,
  pollDeviceToken,
  promoteProjectDeployment,
} from "./api-client.js";
import { createZipArchive } from "./archive.js";
import {
  FileCredentialStore,
  resolveToken,
  type CredentialStore,
} from "./credentials.js";
import { getGitMetadata } from "./git-metadata.js";
import { linkProject, resolveProjectConfig } from "./project-config.js";
import { collectProjectFiles } from "./snapshot.js";

const version = "0.10.0";

type CliDependencies = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  openUrl?: (url: string) => Promise<unknown>;
  credentials?: CredentialStore;
  now?: () => number;
};

type ParsedArguments = {
  command: string;
  positionals: string[];
  options: Map<string, string | true>;
};

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(value));
  const env = dependencies.env ?? process.env;
  const cwd = path.resolve(dependencies.cwd ?? process.cwd());
  const fetchImpl = dependencies.fetch ?? fetch;
  const credentials = dependencies.credentials ?? new FileCredentialStore();
  try {
    const parsed = parseArguments(argv);
    if (parsed.options.has("version") || parsed.command === "version") {
      stdout(`${version}\n`);
      return 0;
    }
    if (parsed.options.has("help") || parsed.command === "help") {
      stdout(helpText());
      return 0;
    }

    switch (parsed.command) {
      case "login": {
        const apiUrl = resolveApiUrl(parsed, env);
        const device = await beginDeviceLogin(apiUrl, fetchImpl);
        stderr(`Open ${device.verification_uri_complete}\n`);
        stderr(`Confirm device code: ${formatUserCode(device.user_code)}\n`);
        if (!parsed.options.has("no-open")) {
          await (dependencies.openUrl ?? ((url) => open(url)))(
            device.verification_uri_complete,
          ).catch(() => undefined);
        }
        const token = await pollDeviceToken({
          apiUrl,
          device,
          fetch: fetchImpl,
          sleep: dependencies.sleep,
        });
        const now = dependencies.now?.() ?? Date.now();
        await credentials.set(apiUrl, {
          token: token.access_token,
          expiresAt: new Date(now + token.expires_in * 1_000).toISOString(),
        });
        stdout(`Logged in to ${apiUrl}\n`);
        return 0;
      }
      case "logout": {
        const apiUrl = resolveApiUrl(parsed, env);
        await credentials.delete(apiUrl);
        stdout(`Logged out of ${apiUrl}\n`);
        return 0;
      }
      case "link": {
        const projectId = optionString(parsed, "project") ?? env.EVELAND_PROJECT_ID;
        if (!projectId) throw new Error("`eveland link` requires --project <project-id>.");
        const apiUrl = resolveApiUrl(parsed, env);
        await linkProject(cwd, { projectId, apiUrl });
        stdout(`Linked ${projectId} (${apiUrl})\n`);
        return 0;
      }
      case "deploy": {
        const root = path.resolve(cwd, parsed.positionals[0] ?? ".");
        const config = await resolveProjectConfig(root, {
          projectId: optionString(parsed, "project"),
          apiUrl: optionString(parsed, "api-url"),
          env,
        });
        const token = await resolveToken(config.apiUrl, {
          explicitToken: optionString(parsed, "token"),
          env,
          store: credentials,
        });
        const target = parsed.options.has("preview") ? "preview" : "production";
        stderr(`Deploying to ${target} from ${root}\n`);
        const snapshot = await collectProjectFiles(root);
        if (snapshot.files.length === 0) throw new Error("The deployment snapshot is empty.");
        stderr(
          `Collected ${snapshot.files.length} files${snapshot.ignoreFile ? ` using ${snapshot.ignoreFile}` : ""}\n`,
        );
        const archive = createZipArchive(snapshot.files);
        let previousStatus = "";
        const result = await deployProject({
          apiUrl: config.apiUrl,
          projectId: config.projectId,
          token,
          archive,
          sourceDigest: snapshot.digest,
          target,
          git: await getGitMetadata(root),
          fetch: fetchImpl,
          sleep: dependencies.sleep,
          onProgress(status) {
            if (status === previousStatus) return;
            previousStatus = status;
            stderr(`${statusLabel(status)}\n`);
          },
        });
        if (parsed.options.has("json")) {
          stdout(`${JSON.stringify({
            projectId: config.projectId,
            target,
            url: result.url,
            sourceDigest: snapshot.digest,
            files: snapshot.files.length,
            operation: result.operation,
          })}\n`);
        } else {
          stdout(`${result.url}\n`);
        }
        return 0;
      }
      case "promote": {
        const deployment = parsed.positionals[0];
        if (!deployment) {
          throw new Error("`eveland promote` requires a deployment ID or preview URL.");
        }
        const root = path.resolve(cwd, parsed.positionals[1] ?? ".");
        const config = await resolveProjectConfig(root, {
          projectId: optionString(parsed, "project"),
          apiUrl: optionString(parsed, "api-url"),
          env,
        });
        const token = await resolveToken(config.apiUrl, {
          explicitToken: optionString(parsed, "token"),
          env,
          store: credentials,
        });
        stderr(`Promoting ${deployment} to production\n`);
        const result = await promoteProjectDeployment({
          apiUrl: config.apiUrl,
          projectId: config.projectId,
          deployment,
          token,
          fetch: fetchImpl,
        });
        stdout(parsed.options.has("json")
          ? `${JSON.stringify(result)}\n`
          : `${result.url}\n`);
        return 0;
      }
      default:
        throw new Error(`Unknown command ${parsed.command || "(none)"}.\n\n${helpText()}`);
    }
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    return { command: "help", positionals, options };
  }
  if (first === "--version" || first === "-v") {
    return { command: "version", positionals, options };
  }
  const command = first ?? "help";
  const valueOptions = new Set(["project", "api-url", "token"]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (valueOptions.has(name)) {
      const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
      if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value.`);
      options.set(name, value);
    } else if (["preview", "json", "help", "version", "no-open"].includes(name)) {
      options.set(name, true);
    } else {
      throw new Error(`Unknown option --${name}.`);
    }
  }
  return { command, positionals, options };
}

function optionString(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function resolveApiUrl(parsed: ParsedArguments, env: NodeJS.ProcessEnv): string {
  const value = optionString(parsed, "api-url") ?? env.EVELAND_API_URL ?? "http://localhost:4000";
  return new URL(value).toString().replace(/\/$/, "");
}

function formatUserCode(value: string): string {
  const clean = value.replace(/-/g, "");
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : value;
}

function statusLabel(status: string): string {
  const [phase, detail] = status.split(":", 2);
  if (phase === "uploading") return "Uploading source…";
  if (phase === "validating") return `Validating source${detail ? ` (${detail})` : ""}…`;
  if (phase === "importing") return "Importing source…";
  if (phase === "building") return "Building release…";
  if (phase === "deploying") return "Starting deployment…";
  if (phase === "promoting") return "Promoting to production…";
  if (phase === "ready") return "Deployment ready.";
  return `${status}…`;
}

function helpText(): string {
  return `Eveland CLI ${version}\n\nUsage:\n  eveland login [--api-url URL]\n  eveland logout [--api-url URL]\n  eveland link --project PROJECT_ID [--api-url URL]\n  eveland deploy [path] [--preview] [--project PROJECT_ID] [--json]\n  eveland promote <deployment-id-or-preview-url> [path] [--project PROJECT_ID] [--json]\n\nDeployments target production by default. Use --preview for an immutable preview only.\n`;
}
