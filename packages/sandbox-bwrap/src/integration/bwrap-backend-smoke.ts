// Real-bwrap backend contract test. Requires Linux + bubblewrap + bash — run it
// inside the Lima VM via infra/integration/run.sh, not on a dev laptop.
// It is intentionally run as an unprivileged user under systemd hardening
// (NoNewPrivileges, ProtectSystem=strict) to mirror a deployed eve agent.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import { createBwrapSandboxBackend } from "../backend.js";
import { isBwrapAvailable } from "../process.js";

const SECRET = "smoke-secret-do-not-leak";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  assert.equal(isBwrapAvailable(), true, "bwrap must be installed in the VM");
  process.env.SMOKE_SECRET = SECRET;

  const appRoot = await mkdtemp(path.join(os.tmpdir(), "bwrap-smoke-"));
  try {
    // Fixture for the HARD LINK probe below, created before any session
    // exists. appRoot's cache subtree (.eve/sandbox-cache/bwrap) is hidden
    // from every sandboxed session, but appRoot itself is not, so this file
    // stays visible read-only through the sandbox's root bind.
    const hostFilePath = path.join(appRoot, "hostfile.txt");
    await writeFile(hostFilePath, "host-original");

    const backend = createBwrapSandboxBackend();
    const runtimeContext = { appRoot };

    // prewarm: bootstrap runs inside bwrap; seeds land in the template
    const first = await backend.prewarm({
      templateKey: "smoke-template",
      runtimeContext,
      seedFiles: [{ path: "seeded.txt", content: "from-seed" }],
      bootstrap: async ({ use }) => {
        const session = await use();
        const result = await session.run({ command: "printf bootstrapped > boot.txt" });
        assert.equal(result.exitCode, 0, `bootstrap command failed: ${result.stderr}`);
        // Fixture for the EXECUTABLE BIT probe below: an executable script
        // authored inside the template, whose mode bit must survive the
        // template->session clone (backend.ts's fs.cp-based copy).
        const chmodResult = await session.run({
          command: "printf '#!/bin/sh\\necho exec-ok\\n' > run-me.sh && chmod +x run-me.sh",
        });
        assert.equal(chmodResult.exitCode, 0, `chmod +x failed in bootstrap: ${chmodResult.stderr}`);
      },
    });
    assert.equal(first.reused, false, "first prewarm must capture fresh state");
    const second = await backend.prewarm({ templateKey: "smoke-template", runtimeContext, seedFiles: [] });
    assert.equal(second.reused, true, "second prewarm must reuse the template");

    // unknown template → typed error
    await assert.rejects(
      backend.create({ templateKey: "never-prewarmed", sessionKey: "sx", runtimeContext }),
      (error: unknown) => SandboxTemplateNotProvisionedError.is(error),
    );

    // create: template state visible in the session workspace
    const handle = await backend.create({ templateKey: "smoke-template", sessionKey: "sess-1", runtimeContext });
    const session = handle.session;
    assert.equal(await session.readTextFile({ path: "seeded.txt" }), "from-seed");
    assert.equal(await session.readTextFile({ path: "boot.txt" }), "bootstrapped");

    // EXECUTABLE BIT probe: unit tests fake the template->session copy away
    // (createFakeRunner never touches disk), so whether the real fs.cp clone
    // preserves the mode bit can only be proven against real bwrap + a real
    // filesystem. Run the bootstrap-authored script directly by name; if the
    // executable bit was lost this fails with a permission error.
    const execProbe = await session.run({ command: "./run-me.sh" });
    assert.equal(execProbe.exitCode, 0, `executable bit lost across template->session copy: ${execProbe.stderr}`);
    assert.equal(execProbe.stdout.trim(), "exec-ok", "run-me.sh did not produce the expected output");
    console.log("EXECUTABLE BIT PROBE: template->session copy preserved the executable bit");

    // cwd is /workspace
    const pwd = await session.run({ command: "pwd" });
    assert.equal(pwd.stdout.trim(), "/workspace");

    // rootfs is read-only outside /workspace
    const readOnly = await session.run({ command: "touch /usr/smoke-marker" });
    assert.notEqual(readOnly.exitCode, 0, "writing outside /workspace must fail");

    // host process env must NOT leak into the sandbox
    const env = await session.run({ command: "env" });
    assert.ok(!env.stdout.includes(SECRET), "host process env leaked into the sandbox");
    assert.ok(env.stdout.includes("HOME=/workspace"), "sandbox HOME must be /workspace");

    // the sandbox cache root (other sessions + templates) is hidden
    const cacheLs = await session.run({ command: `ls -A ${appRoot}/.eve/sandbox-cache/bwrap` });
    assert.equal(cacheLs.stdout.trim(), "", "sandbox cache root must be hidden by tmpfs");

    // PID NAMESPACE probe: --unshare-net has a sibling flag, --unshare-pid,
    // that must give the sandbox its own private process table instead of a
    // view into the host's (a deployed agent host runs dozens of processes:
    // systemd, sshd, other units, ...). A ProcessRunner test double cannot
    // fake real pid-namespace isolation — it requires a real kernel
    // namespace — so this can only be proven here.
    const procCount = await session.run({ command: "ls /proc | grep -Ec '^[0-9]+$'" });
    assert.equal(procCount.exitCode, 0, `proc count probe failed: ${procCount.stderr}`);
    const sandboxPidCount = Number.parseInt(procCount.stdout.trim(), 10);
    assert.ok(
      Number.isInteger(sandboxPidCount) && sandboxPidCount > 0 && sandboxPidCount <= 5,
      `PID namespace isolation failed: /proc showed ${procCount.stdout.trim()} entries inside the sandbox ` +
        "(expected a tiny private table from --unshare-pid, not the host's)",
    );
    console.log(`PID NAMESPACE PROBE: sandbox /proc shows ${sandboxPidCount} process(es), own namespace confirmed`);

    // network: allow-all sees a non-loopback interface; deny-all does not.
    // /sys/class/net shows the namespace that mounted sysfs, so ask the kernel
    // via netlink (os.networkInterfaces) instead.
    const ifaceCommand = `node -e "console.log(Object.keys(require('node:os').networkInterfaces()).join(' '))"`;
    const allowNet = await session.run({ command: ifaceCommand });
    assert.equal(allowNet.exitCode, 0, `iface probe failed: ${allowNet.stderr}`);
    assert.ok(
      allowNet.stdout.trim().split(/\s+/).some((name) => name !== "" && name !== "lo"),
      "allow-all must see a host network interface",
    );
    await session.setNetworkPolicy("deny-all");
    const denyNet = await session.run({ command: ifaceCommand });
    assert.equal(
      denyNet.stdout.trim().split(/\s+/).filter((name) => name !== "" && name !== "lo").length,
      0,
      "deny-all must leave at most loopback",
    );
    await session.setNetworkPolicy("allow-all");

    // HARD LINK probe: a distinct escape class from the symlink escape Task 3
    // closed via isWithinWorkspaceReal. A hard link creates a second
    // directory entry aliasing the SAME inode across a bind mount of one
    // underlying superblock; realpath-based containment cannot see this,
    // because the new path genuinely resolves inside the workspace — only
    // the inode is shared with a file outside it. We deliberately do not
    // assert a pass/fail verdict: whichever way the kernel resolves this is
    // a fact about the sandbox's security boundary for the controller to
    // evaluate, not a bug in this smoke test's expectations.
    const linkResult = await session.run({
      command: `ln '${hostFilePath}' /workspace/linked.txt 2>&1; echo rc=$?`,
    });
    const linkSucceeded = linkResult.stdout.trim().endsWith("rc=0");
    if (linkSucceeded) {
      await session.run({ command: "printf pwned > /workspace/linked.txt" });
    }
    const hostFileAfter = await readFile(hostFilePath, "utf8").catch((error: unknown) => `<unreadable: ${String(error)}>`);
    console.log(
      `HARDLINK PROBE: ${linkSucceeded ? "succeeded" : "refused"} host-file-after=${JSON.stringify(hostFileAfter)}`,
    );

    // spawn + kill terminates the sandboxed tree promptly
    const proc = await session.spawn({ command: "sleep 300" });
    await sleep(200);
    await proc.kill();
    const settled = await Promise.race([
      Promise.resolve(proc.wait()).then(
        () => "settled",
        () => "settled",
      ),
      sleep(5000).then(() => "timeout"),
    ]);
    assert.equal(settled, "settled", "killed spawn must settle wait() promptly");

    // shutdown() must leave nothing running: spawn a sleeper, shut down, and
    // confirm the process is gone from the host.
    const sleeper = await session.spawn({ command: "sleep 300" });
    const sleeperPid = sleeper.pid;
    await handle.shutdown();
    assert.ok(sleeperPid !== undefined, "spawn must expose a pid");
    assert.equal(processIsAlive(sleeperPid), false, "shutdown() must kill spawned processes");

    // persistence across reconnect; isolation between sessions
    await session.writeTextFile({ path: "notes/hello.txt", content: "persisted" });
    await handle.shutdown();
    const again = await backend.create({ templateKey: "smoke-template", sessionKey: "sess-1", runtimeContext });
    assert.equal(await again.session.readTextFile({ path: "notes/hello.txt" }), "persisted");
    const other = await backend.create({ templateKey: "smoke-template", sessionKey: "sess-2", runtimeContext });
    assert.equal(await other.session.readTextFile({ path: "notes/hello.txt" }), null);

    console.log("BWRAP SMOKE OK");
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
