import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type StoredCredential = {
  token: string;
  expiresAt: string;
};

export interface CredentialStore {
  get(instanceUrl: string): Promise<StoredCredential | null>;
  set(instanceUrl: string, credential: StoredCredential): Promise<void>;
  delete(instanceUrl: string): Promise<void>;
}

type AuthFile = {
  version: 1;
  sessions: Record<string, StoredCredential & { instanceUrl: string }>;
};

export class FileCredentialStore implements CredentialStore {
  readonly filePath: string;

  constructor(configDir = defaultConfigDir()) {
    this.filePath = path.join(configDir, "auth.json");
  }

  async get(instanceUrl: string): Promise<StoredCredential | null> {
    const normalized = normalizeInstanceUrl(instanceUrl);
    const session = (await this.read()).sessions[credentialKey(normalized)];
    if (!session || session.instanceUrl !== normalized) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.delete(normalized);
      return null;
    }
    return { token: session.token, expiresAt: session.expiresAt };
  }

  async set(instanceUrl: string, credential: StoredCredential): Promise<void> {
    const normalized = normalizeInstanceUrl(instanceUrl);
    const data = await this.read();
    data.sessions[credentialKey(normalized)] = { ...credential, instanceUrl: normalized };
    await this.write(data);
  }

  async delete(instanceUrl: string): Promise<void> {
    const normalized = normalizeInstanceUrl(instanceUrl);
    const data = await this.read();
    delete data.sessions[credentialKey(normalized)];
    await this.write(data);
  }

  private async read(): Promise<AuthFile> {
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AuthFile>;
      return {
        version: 1,
        sessions:
          data.sessions && typeof data.sessions === "object"
            ? data.sessions
            : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, sessions: {} };
      }
      throw error;
    }
  }

  private async write(data: AuthFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.auth-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function resolveToken(
  instanceUrl: string,
  options: {
    explicitToken?: string;
    env?: NodeJS.ProcessEnv;
    store?: CredentialStore;
  } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const token = options.explicitToken?.trim() || env.EVELAND_TOKEN?.trim();
  if (token) return token;
  const credential = await (options.store ?? new FileCredentialStore()).get(instanceUrl);
  if (credential) return credential.token;
  throw new Error(`Not logged in to ${normalizeInstanceUrl(instanceUrl)}. Run \`eveland login --url ${normalizeInstanceUrl(instanceUrl)}\`.`);
}

function defaultConfigDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "eveland")
    : path.join(os.homedir(), ".config", "eveland");
}

function credentialKey(instanceUrl: string): string {
  return createHash("sha256").update(instanceUrl).digest("base64url");
}

function normalizeInstanceUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}
