import { execa } from "execa";

export const observerVerifyScript = `import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.argv[1];
const id = randomUUID();
const temporary = path.join(root, ".observer-probe-" + id + ".tmp");
const ready = path.join(root, ".observer-probe-" + id + ".ready");
await writeFile(temporary, "probe", { flag: "wx" });
await rename(temporary, ready);
await rm(ready);
console.log("OBSERVER OUTBOX VERIFY OK");
`;

export function buildObserverVerifyArgs(input: { user: string; outboxDir: string }): string[] {
  return [
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    `--property=User=${input.user}`,
    "--property=NoNewPrivileges=yes",
    "--property=ProtectSystem=strict",
    "--property=PrivateTmp=yes",
    `--property=ReadWritePaths=${input.outboxDir}`,
    "node",
    "--input-type=module",
    "-e",
    observerVerifyScript,
    input.outboxDir,
  ];
}

export async function verifyObserverOutbox(input: { user: string; outboxDir: string }): Promise<void> {
  const result = await execa("systemd-run", buildObserverVerifyArgs(input), { all: true, reject: false });
  const output = result.all ?? "";
  if (result.exitCode !== 0 || !output.includes("OBSERVER OUTBOX VERIFY OK")) {
    throw new Error(
      `Observer outbox self-check failed for deployment user ${input.user} at ${input.outboxDir}. ` +
        `The directory must allow create, atomic rename, and delete under deployment hardening. Captured output (exit=${result.exitCode ?? "unknown"}):\n${output}`,
    );
  }
}
