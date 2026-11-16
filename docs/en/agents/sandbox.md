---
title: Agent sandbox
description: What sandboxed commands can do on Eveland, the limits that bound them, and the security boundary around them.
---

Every eve sandbox on Eveland, the one behind the built-in `bash`, `read_file`, and `write_file` tools included, runs on [`@evelandhq/sandbox-bwrap`](https://github.com/evelandhq/sandbox-bwrap), a bubblewrap provider. You do not configure it: the platform injects it into every Release.

## 1. Your sandbox module

- An authored `agent/sandbox` module keeps working. Its `prepare` step and its `defineSandbox()` selector run unchanged, and the workspace seeds under `agent/sandbox/workspace/**` are copied in.
- Every built-in provider (`DefaultSandbox`, `DockerSandbox`, `VercelSandbox`, `JustBashSandbox`) builds the bubblewrap environment instead, so provider-specific options such as an image or a Dockerfile are ignored.
- The build fails if any sandbox was prepared on another provider: an environment built in a helper file rather than the sandbox module, a custom provider from `eve/sandbox/provider`, or a sandbox shipped by an Extension.

## 2. What commands see

- **Host tools, read-only.** The host's root filesystem is mounted read-only, so whatever the host has installed (`git`, `node`, `python3`, and so on) runs inside. `git` works over https.
- **Nothing installs into system paths.** Commands run as the Agent's unprivileged user, so `apt-get`, `sudo`, and eve's `installCodeTooling` fail. Install user-level tools into the workspace, for example with `pip install --user` or `npm install --prefix`, or ask the operator to install them on the host.
- **One writable directory.** Each session has its own `/workspace`. It survives restarts and redeploys of the Deployment and is removed when the session ends.
- **A fresh `/tmp` per command.** No process outlives the command that started it. Keep anything later commands need under `/workspace`. eve's `bash` tool therefore cannot hand a long command off as a background job: it waits for the command to finish, up to the run timeout.
- **A clean environment.** The Agent's environment, its secrets included, is never passed to sandboxed commands. They see `PATH`, `HOME=/workspace`, `LANG`, `AI_AGENT=eve`, and the `env` your code passes.

## 3. Limits

The operator sets these per instance; they apply to every Deployment.

| Variable                                   | Default             | Bounds                                          |
| ------------------------------------------ | ------------------- | ----------------------------------------------- |
| `EVELAND_SANDBOX_RUN_TIMEOUT_MS`           | `600000` (10 min)   | Wall-clock time of one command                  |
| `EVELAND_SANDBOX_MAX_OUTPUT_BYTES`         | `16777216` (16 MiB) | Combined stdout and stderr one command delivers |
| `EVELAND_SANDBOX_MAX_CONCURRENT_PROCESSES` | `64`                | Live commands in one sandbox session at a time  |

The run timeout and output limit apply to every command, including a long-running process started with `spawn()`, such as a dev server or a file watcher. At either limit the command's whole process group is killed. If your Agent keeps such processes running, the operator has to raise `EVELAND_SANDBOX_RUN_TIMEOUT_MS`.

## 4. Network

The sandbox shares the host's network by default (`"allow-all"`). A sandbox can switch to `"deny-all"`, which leaves only loopback, through `environment.open({ networkPolicy: "deny-all" })` or `setNetworkPolicy()`. There is nothing in between: domain allow-lists and header-rewriting policies are refused, not weakened.

## 5. Security boundary

The sandbox protects against mistakes, prompt injection, and code the Agent was tricked into running. It is not isolation between mutually hostile tenants.

- **Secrets stay out.** Sandboxed commands never inherit the Agent's process environment.
- **The host is visible, read-only.** bubblewrap hides only the sandbox caches. What keeps the platform's data and other projects out of view is the boundary around the Agent process itself: under systemd each Deployment's unit mounts an empty filesystem over the platform data root and binds back only its own Release, sandbox cache, and memory directory; under Docker the container does the same. A sandboxed command can read what its Agent process can read, and no more.
- **Sessions of one Deployment share a trust domain.** They run as the same user, and eve's host-side file reads are not confined to one session's workspace.
- **One kernel.** Sandboxed processes share the host kernel. If your threat model needs hostile multi-tenant execution, run that work in a VM-isolated service and call it from the Agent.

## Related references

- [Known limitations](/docs/reference/known-limitations): features Eveland does not host
- [Why a bubblewrap sandbox](/docs/reference/design/sandbox): the reasoning behind the provider and its build-time checks
- [Security model](/docs/operations/security): the platform's privilege boundaries
- [Environment variables](/docs/reference/environment-variables): the sandbox limits and cache location
