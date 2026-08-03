import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { SANDBOX_PNPM_VERSION } from "./sandbox-toolchain.js";

const expectedAptPackages = [
  "bash",
  "bubblewrap",
  "ca-certificates",
  "curl",
  "findutils",
  "git",
  "grep",
  "jq",
  "python-is-python3",
  "python3",
  "python3-pip",
  "ripgrep",
  "unzip",
  "zstd",
];

describe("systemd sandbox toolchain provisioning", () => {
  test("pins the same pnpm version as the workspace", async () => {
    const workspaceManifest = JSON.parse(
      await readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
    ) as { packageManager?: string };

    expect(workspaceManifest.packageManager).toBe(`pnpm@${SANDBOX_PNPM_VERSION}`);
  });

  test("installs the platform-owned commands in the real Lima host", async () => {
    const limaConfig = await readFile(
      new URL("../../../../infra/lima/eveland.yaml", import.meta.url),
      "utf8",
    );
    const aptPackages =
      limaConfig.match(/^\s*apt-get install -y ([^\n]+)$/m)?.[1]?.split(/\s+/) ?? [];

    expect(aptPackages).toEqual(expect.arrayContaining(expectedAptPackages));
    expect(limaConfig).toContain(`corepack install --global pnpm@${SANDBOX_PNPM_VERSION}`);
  });

  test("upgrades a reused Lima host before invoking pnpm or the worker preflight", async () => {
    const integrationScript = await readFile(
      new URL("../../../../infra/integration/run.sh", import.meta.url),
      "utf8",
    );
    const aptPackages =
      integrationScript.match(/^\s*apt-get install -y ([^\n]+)$/m)?.[1]?.split(/\s+/) ?? [];
    const toolchainInstallIndex = integrationScript.indexOf("apt-get install -y");
    const workspaceInstallIndex = integrationScript.indexOf(
      "corepack pnpm install --frozen-lockfile",
    );

    expect(aptPackages).toEqual(expect.arrayContaining(expectedAptPackages));
    expect(integrationScript).toContain(`corepack install --global pnpm@${SANDBOX_PNPM_VERSION}`);
    expect(toolchainInstallIndex).toBeGreaterThan(-1);
    expect(toolchainInstallIndex).toBeLessThan(workspaceInstallIndex);
  });
});
