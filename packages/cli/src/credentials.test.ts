import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  credentialPath,
  credentialsDir,
  listCredentialOrigins,
  loadCredential,
  removeCredential,
  resolveToken,
  saveCredential,
} from "./credentials.ts";

async function testEnv(): Promise<NodeJS.ProcessEnv> {
  return { XDG_CONFIG_HOME: await mkdtemp(path.join(os.tmpdir(), "eveland-cli-creds-")) };
}

const CREDENTIAL = {
  accessToken: "token-a",
  tokenType: "Bearer",
  scopes: ["deploy", "observe"],
  obtainedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
};

describe("credentials store", () => {
  test("saves one file per origin with user-only permissions", async () => {
    const env = await testEnv();
    const filePath = await saveCredential("http://a.example", CREDENTIAL, env);
    await saveCredential("http://b.example:17300", { ...CREDENTIAL, accessToken: "token-b" }, env);

    expect(filePath).toBe(credentialPath("http://a.example", env));
    const fileMode = (await stat(filePath)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = (await stat(credentialsDir(env))).mode & 0o777;
    expect(dirMode).toBe(0o700);

    await expect(loadCredential("http://a.example", env)).resolves.toEqual(CREDENTIAL);
    await expect(loadCredential("http://b.example:17300", env)).resolves.toMatchObject({
      accessToken: "token-b",
    });
    await expect(loadCredential("http://c.example", env)).resolves.toBeNull();
    await expect(listCredentialOrigins(env)).resolves.toEqual([
      "http://a.example",
      "http://b.example:17300",
    ]);
  });

  test("logout removes exactly one origin's file", async () => {
    const env = await testEnv();
    await saveCredential("http://a.example", CREDENTIAL, env);
    await saveCredential("http://b.example", CREDENTIAL, env);

    await expect(removeCredential("http://a.example", env)).resolves.toBe(true);
    await expect(loadCredential("http://b.example", env)).resolves.not.toBeNull();
    await expect(removeCredential("http://a.example", env)).resolves.toBe(false);
    await expect(removeCredential("http://b.example", env)).resolves.toBe(true);
    await expect(listCredentialOrigins(env)).resolves.toEqual([]);
  });

  test("concurrent logins to different origins cannot interfere: separate files, no shared state", async () => {
    const env = await testEnv();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        saveCredential(
          `http://origin-${index}.example`,
          { ...CREDENTIAL, accessToken: `token-${index}` },
          env,
        ),
      ),
    );
    for (let index = 0; index < 8; index += 1) {
      await expect(loadCredential(`http://origin-${index}.example`, env)).resolves.toMatchObject({
        accessToken: `token-${index}`,
      });
    }
    // Atomic rename leaves complete JSON behind, never temp-file residue.
    const contents = await readFile(credentialPath("http://origin-0.example", env), "utf8");
    expect(JSON.parse(contents).accessToken).toBe("token-0");
    await expect(listCredentialOrigins(env)).resolves.toHaveLength(8);
  });

  test("EVELAND_TOKEN overrides the stored credential", async () => {
    const env = await testEnv();
    await saveCredential("http://a.example", CREDENTIAL, env);
    await expect(resolveToken("http://a.example", env)).resolves.toEqual({
      token: "token-a",
      source: "stored",
    });
    await expect(
      resolveToken("http://a.example", { ...env, EVELAND_TOKEN: "ci-token" }),
    ).resolves.toEqual({ token: "ci-token", source: "env" });
    await expect(resolveToken("http://none.example", env)).resolves.toBeNull();
  });
});
