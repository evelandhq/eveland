# Agent Chats Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified `/chats/:chat_id` experience where a chat is created by choosing one deployed agent/project and remains bound to that agent.

**Architecture:** Build the feature in vertical slices. First add backend chat persistence and API endpoints with tests. Then add frontend API helpers and UI routes for chat history, chat creation, and the chat page. Finally verify typecheck, tests, and build.

**Tech Stack:** TypeScript, Hono API, in-memory/Postgres store abstraction, Drizzle, Next.js App Router, pnpm, Vitest.

## Global Constraints

- Use strict TDD: write failing tests before production code for each backend behavior.
- Use branch `feat-agent-chats` and Git identity `Oscar Jiang <pengj0520@gmail.com>`.
- Commit each completed, verified vertical slice.
- URL for chat pages is `/chats/:chat_id`.
- A chat is bound to one agent/project and cannot switch agents.
- First version shows current user's chats only.
- Chat title is generated from the first user message.
- Deleted agents leave chat history viewable but disable new messages.

---

### Task 1: Backend chat persistence and API

**Files:**
- Modify: `apps/api/src/types.ts`
- Modify: `apps/api/src/store.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/mappers.ts`
- Modify: `apps/api/src/db/postgres-store.ts`
- Create: `apps/api/drizzle/<migration>.sql` if required

**Interfaces:**
- Produces API endpoints:
  - `GET /chats`
  - `POST /chats` with `{ projectId, message }`
  - `GET /chats/:chatId`
  - `POST /chats/:chatId/messages` with `{ message }`

- [ ] Write failing API tests for chat creation, listing, continuation, immutable project binding, and deleted-project read-only behavior.
- [ ] Run the specific API tests and confirm they fail for missing routes/store methods.
- [ ] Implement chat types, store methods, memory store behavior, app routes, and Postgres mappings.
- [ ] Run API tests and typecheck; fix until green.
- [ ] Commit `feat: add agent chat api`.

### Task 2: Frontend chat history and creation flow

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/app/chats/page.tsx`
- Modify: `apps/web/src/app/projects/page.tsx`
- Modify: `apps/web/src/app/projects/[projectId]/page.tsx`

**Interfaces:**
- Consumes backend chat APIs from Task 1.
- Produces `/chats` history page and entry points to create a chat from deployed agents.

- [ ] Add web API helpers and types for chats.
- [ ] Add `/chats` history page showing current user's chats, agent name, updated time, and latest message.
- [ ] Add Start chat links/actions from project list and project overview for deployed agents.
- [ ] Run web typecheck and tests; fix until green.
- [ ] Commit `feat: add chat history and creation ui`.

### Task 3: Frontend chat detail page

**Files:**
- Create: `apps/web/src/app/chats/[chatId]/page.tsx`
- Create: `apps/web/src/components/chat-panel.tsx`

**Interfaces:**
- Consumes `GET /chats/:chatId` and `POST /chats/:chatId/messages`.
- Produces `/chats/:chat_id` chat page.

- [ ] Add chat page displaying bound agent name, messages, input, loading state, and errors.
- [ ] Disable input and show a clear message if the bound agent has been deleted.
- [ ] Run web typecheck and tests; fix until green.
- [ ] Commit `feat: add bound agent chat page`.

### Task 4: Final verification and PR

**Files:**
- All changed files.

- [ ] Run full repository tests.
- [ ] Run full repository typecheck.
- [ ] Run full build if feasible.
- [ ] Push branch and create PR linked to issue #6.
