# Starter agent

A working eve agent for the eveland platform: a tour guide that demonstrates
sessions, tools, durable timers, and the public URL.
Seeded by `eveland-ctl` as an instance's first agent.

## Layout

| File                    | What to change                                               |
| ----------------------- | ------------------------------------------------------------ |
| `agent/instructions.md` | The persona — its **first line** is the one to edit          |
| `agent/agent.ts`        | Model pin                                                    |
| `agent/tools/`          | One file per tool; `sleep.ts` re-exports eve's durable sleep |
| `agent/channels/eve.ts` | Chat channel + authentication                                |

## Deploy it

```bash
eveland login --origin <your instance>
eveland deploy
```

Or import this directory through the Dashboard (zip or Git URL).

## Adding a schedule

None ships by default — a cron schedule spends tokens on a timer. When you
want one, create `agent/schedules/daily-digest.md` (five-field cron, minute
resolution, read in UTC unless you add an IANA `timezone:` line):

```md
---
cron: "0 9 * * *"
---

Summarize yesterday's sessions in two sentences.
```

## Enabling per-user memory (deliberately not on by default)

Agent memory scoped `byPrincipal` is only as isolated as the identities behind
it. A new instance's Identity Provider defaults to `Open`, where every public
visitor shares one identity — per-user memory there would silently share one
memory (and the personal details users tell the agent) across all visitors.
Once the instance uses `Internal` or `OIDC` identity (Settings → Identity),
add `agent/memory.ts`:

```ts
import { defaultNamespace, defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";
import { evelandMemoryBackend, evelandMemoryNamespace } from "eveland/memory";

export default defineMemory({
  scope: byPrincipal,
  namespace: evelandMemoryNamespace(defaultNamespace),
  provider: fileMemory({ backend: evelandMemoryBackend() }),
});
```

The explicit backend matters: bare `fileMemory()` only auto-resolves under
`eve dev`; `evelandMemoryBackend()` reads the platform-injected
`EVELAND_MEMORY_ROOT` and steps aside anywhere else, so the file works
unchanged under `eve dev` too. The namespace matters as much: Eve's default
one changes with every Release's build directory, so without
`evelandMemoryNamespace` each redeploy starts with empty memory.

## Ground rules baked into this template

- **Text files only.** Binary files do deploy, but they are invisible in the
  Dashboard's Source page and bloat every upload — this template stays pure
  text so what you browse is exactly what runs.
- **No sandbox backend.** The platform injects its managed sandbox; an
  authored `agent/sandbox/` would be replaced anyway.
- **The "remind me" beat needs the workflow dispatcher** (part of every
  standard install) — durable sleeps never fire without it.
