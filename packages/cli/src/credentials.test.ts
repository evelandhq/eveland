import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  credentialsPath,
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
  test("saves per origin with user-only permissions", async () => {
    const env = await testEnv();
    const filePath = await saveCredential("http://a.example", CREDENTIAL, env);
    await saveCredential("http://b.example", { ...CREDENTIAL, accessToken: "token-b" }, env);

    expect(filePath).toBe(credentialsPath(env));
    const fileMode = (await stat(filePath)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = (await stat(path.dirname(filePath))).mode & 0o777;
    expect(dirMode).toBe(0o700);

    await expect(loadCredential("http://a.example", env)).resolves.toEqual(CREDENTIAL);
    await expect(loadCredential("http://b.example", env)).resolves.toMatchObject({
      accessToken: "token-b",
    });
    await expect(loadCredential("http://c.example", env)).resolves.toBeNull();
  });

  test("logout removes one origin and deletes the file with the last one", async () => {
    const env = await testEnv();
    await saveCredential("http://a.example", CREDENTIAL, env);
    await saveCredential("http://b.example", CREDENTIAL, env);

    await expect(removeCredential("http://a.example", env)).resolves.toBe(true);
    await expect(loadCredential("http://b.example", env)).resolves.not.toBeNull();
    await expect(removeCredential("http://a.example", env)).resolves.toBe(false);
    await expect(removeCredential("http://b.example", env)).resolves.toBe(true);
    await expect(readFile(credentialsPath(env), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("concurrent mutations do not lose each other's origins", async () => {
    const env = await testEnv();
    // Racing read-modify-writes used to let the last writer clobber the
    // other's origin; the lock serializes them.
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
    // The lock is released after the burst.
    await expect(
      readFile(`${credentialsPath(env)}.lock`, "utf8").then(
        () => "present",
        () => "absent",
      ),
    ).resolves.toBe("absent");
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
