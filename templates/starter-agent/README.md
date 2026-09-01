# Starter agent

A working eve agent for the eveland platform: a tour guide that demonstrates
sessions, tools, cross-session memory, durable timers, and the public URL.
Scaffolded by `eveland init`; also seeded as an instance's first agent.

## Layout

| File                    | What to change                                               |
| ----------------------- | ------------------------------------------------------------ |
| `agent/instructions.md` | The persona — its **first line** is the one to edit          |
| `agent/agent.ts`        | Model pin                                                    |
| `agent/tools/`          | One file per tool; `sleep.ts` re-exports eve's durable sleep |
| `agent/memory.ts`       | Per-user memory (explicit backend — see the comment inside)  |
| `agent/channels/eve.ts` | Chat channel + authentication; keep its literal shape        |

## Deploy it

```bash
eveland login --origin <your instance>
eveland deploy
```

Or import this directory through the Dashboard (zip or Git URL).

## Adding a schedule

None ships by default — a cron schedule spends tokens on a timer. When you
want one, create `agent/schedules/daily-digest.md` (five-field cron, UTC,
minute resolution):

```md
---
cron: "0 9 * * *"
---

Summarize yesterday's sessions in two sentences.
```

## Ground rules baked into this template

- **Text files only.** Binary files are silently dropped by source import;
  never add images or archives to the project.
- **No sandbox backend.** The platform injects its managed sandbox; an
  authored `agent/sandbox/` would be replaced anyway.
- **The "remind me" beat needs the workflow dispatcher** (part of every
  standard install) — durable sleeps never fire without it.
