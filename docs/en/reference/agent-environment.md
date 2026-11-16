---
title: Agent environment and variable hierarchy contract
description: Specification for project variables/secrets, the Shared Agent Environment, build-visible variables, and persistent memory storage.
---

An agent process's runtime environment combines three distinct layers with deterministic precedence:

$$\text{Shared Agent Environment} < \text{Project Variables \& Secrets} < \text{Platform Reserved Variables}$$

---

## 1. Project variables and secrets (Project Settings)

Configures environment variables and credentials specific to an individual project:

- **Type distinctions**:
  - `variable`: Non-sensitive configuration (e.g. `LOG_LEVEL`, `MODEL_NAME`). Exposed to build scripts (`npx eve build`) to compile release manifests.
  - `secret`: Sensitive credentials (e.g. API keys, database URLs). Injected exclusively into running processes, **never leaking into archives, build logs, or client responses**.
- **Limits and bulk import**: Supports up to 50 variables per project; supports pasting `.env` files for batch preview and saving.
- **Asynchronous reload**: Mutating variables queues rolling restarts for all active (`running` or `draining`) deployments, reloading environment variables while reusing the immutable release artifact.

---

## 2. Shared Agent Environment

Centrally managed by administrators under `/settings/shared-agent-environment`:

- **Universal inheritance**: Automatically inherited by all agents across the platform, ideal for universal foundation model keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
- **Project-level overrides**: Project-specific variables take precedence over matching keys in the shared environment.
- **Secure injection**: Values are encrypted at rest with `APP_SECRET_KEY` and materialized only as root-owned, mode `0600` files read by systemd, avoiding command-line (argv) exposure.

---

## 3. Build-visible variables

Eve projects statically resolve certain configuration during compilation (`npx eve build`):

- The build sandbox receives only non-sensitive `variable` entries from project and shared environments;
- Sensitive `secret` entries are **strictly withheld from the build environment**, preventing untrusted npm lifecycle scripts (`postinstall`) from exfiltrating credentials.

---

## 4. Persistent agent memory (`EVELAND_MEMORY_ROOT`)

- **Memory contract**: Eveland injects `EVELAND_MEMORY_ROOT` into agent processes: the directory where an agent's file memory lives. eve does not read it. Outside `eve dev`, a bare `fileMemory()` has no backend and fails, so an agent that uses file memory passes the `eveland` SDK's backend, which reads `EVELAND_MEMORY_ROOT`:

  ```ts
  // agent/memory.ts
  import { defineMemory } from "eve/memory";
  import { fileMemory } from "eve/memory/file";
  import { byPrincipal } from "eve/memory/scope";
  import { evelandMemoryBackend } from "eveland/memory";

  export default defineMemory({
    scope: byPrincipal,
    provider: fileMemory({ backend: evelandMemoryBackend() }),
  });
  ```

  Under `eve dev`, where `EVELAND_MEMORY_ROOT` is unset, `evelandMemoryBackend()` steps aside and eve's own local backend applies, so the same file works in both places. Scope memory by principal only once the instance uses `Internal` or `OIDC` identity: under the default `Open` provider every visitor shares one principal.

- **Tenant isolation**: The Worker binds this to a dedicated host path: `<EVELAND_DATA_DIR>/memory/<projectId>`. The directory persists across redeployments and restarts, and is cleaned up only upon project deletion.

## 5. Model Gateway reserved variables

- `EVELAND_MODEL_GATEWAY_KIND` and `EVELAND_MODEL_GATEWAY_URL` belong to the platform reserved layer and are always present: when the project uses the instance's Model Gateway they carry the gateway kind and address; otherwise they are empty. A same-named project or shared entry is overridden, so a project cannot aim the platform-injected provider at another gateway.
- The key is not reserved: it is the project's own `AI_GATEWAY_API_KEY` secret, and the platform never supplies one. The full rules are in the [Model Gateway contract](/docs/reference/model-gateway).

## Deeper reference

- [Secrets and Connections](/docs/agents/secrets-connections): developer guide to credentials and interactive auth
- [Security model](/docs/operations/security): encryption at rest and process privilege models
