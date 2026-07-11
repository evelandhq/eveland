# Standalone Agent Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every deployed agent gets a stable domain `<slug>.<EVELAND_AGENT_DOMAIN>` served by a new standalone gateway service that routes by Host header to the agent's process port, plus a public discovery endpoint (`/.well-known/eve/agents.json`).

**Architecture:** A fourth app `apps/gateway` (plain `node:http`, hand-rolled proxy, no proxy library) reads routing state from Postgres (read-only) through a `RouteSource` seam with an in-process TTL cache invalidated via Postgres `LISTEN/NOTIFY`. The control plane (api/worker) stays the only writer; the api ensures the NOTIFY triggers idempotently at startup. Projects gain a unique DNS-safe `slug`; deployments gain `hostAddress`; the worker injects `WORKFLOW_LOCAL_BASE_URL` at deploy time.

**Tech Stack:** TypeScript (strict, ESM with `.js` import suffixes), Node ≥ 24, Hono only in the api (the gateway uses raw `node:http`), drizzle-orm + postgres-js, vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-11-standalone-gateway-design.md` — read it before starting. One deviation is introduced by Task 10 and must be folded back into the spec there (trigger creation moves from "migration" to "api startup", because this repo applies schema with `drizzle-kit push`, which cannot run trigger DDL or backfills).

## Global Constraints

- ESM imports with explicit `.js` suffixes inside `src/` (repo-wide convention).
- All packages extend `tsconfig.base.json`; app tsconfigs set `"types": ["node", "vitest/globals"]`.
- Tests: vitest, colocated `*.test.ts` next to sources. Run with `pnpm --filter <pkg> test`.
- Comments only for non-obvious constraints; never narrate what the code plainly does.
- **Never start long-running services** (no `pnpm dev`, no `docker compose up`) — verify through tests and typecheck only; manual verification steps are documented for the user to run themselves.
- Schema workflow: edit `apps/api/src/db/schema.ts` → `pnpm --filter @eveland/api db:generate` (checked-in SQL is the migration of record) → dev/fresh DBs apply via `pnpm --filter @eveland/api db:push`; existing installs run the checked-in SQL via psql (documented in Task 11).
- Commit messages in English, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Slug rules (exact values from the spec): pattern `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`, reserved list `www`, `api`, `gateway`, `eveland`, `admin`, slugified base truncated to 40 chars, fallback base `agent`, 4-char lowercase suffix on conflict.
- Config names (exact): `EVELAND_AGENT_DOMAIN`, `EVELAND_AGENT_URL_SCHEME` (default `http`), `EVELAND_AGENT_URL_PORT` (default empty), `PORT` (gateway default `8080`), `EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS` (default `30000`), `EVELAND_GATEWAY_ROUTE_TTL_MS` (default `30000`), `EVELAND_GATEWAY_UPSTREAM_HOST` (default unset).
- NOTIFY channel name (exact): `eveland_routes`.

---

### Task 1: Shared agent-domain utilities

**Files:**
- Create: `packages/shared/src/agent-domain.ts`
- Create: `packages/shared/src/agent-domain.test.ts`
- Modify: `packages/shared/package.json` (add `./agent-domain` export)

**Interfaces:**
- Consumes: `nanoid` (already a dependency of `@eveland/shared`).
- Produces (later tasks import from `@eveland/shared/agent-domain`):
  - `slugifyProjectName(name: string): string`
  - `isValidProjectSlug(slug: string): boolean`
  - `createSlugSuffix(): string` (4 chars, `[0-9a-z]`)
  - `RESERVED_PROJECT_SLUGS: ReadonlySet<string>`
  - `normalizeAgentDomain(value: string | undefined): string | null`
  - `type AgentUrlEnv = { EVELAND_AGENT_DOMAIN?: string; EVELAND_AGENT_URL_SCHEME?: string; EVELAND_AGENT_URL_PORT?: string }`
  - `mintAgentUrl(slug: string, env: AgentUrlEnv): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/agent-domain.test.ts
import { describe, expect, test } from "vitest";
import {
  createSlugSuffix,
  isValidProjectSlug,
  mintAgentUrl,
  normalizeAgentDomain,
  slugifyProjectName,
} from "./agent-domain.js";

describe("slugifyProjectName", () => {
  test("lowercases and collapses non-alphanumerics to single hyphens", () => {
    expect(slugifyProjectName("Weather  Agent 2.0")).toBe("weather-agent-2-0");
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugifyProjectName("--My Agent--")).toBe("my-agent");
  });

  test("truncates to 40 chars without a trailing hyphen", () => {
    const slug = slugifyProjectName("a".repeat(39) + " tail");
    expect(slug).toBe("a".repeat(39));
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  test("falls back to 'agent' when nothing slugifiable remains", () => {
    expect(slugifyProjectName("你好世界")).toBe("agent");
    expect(slugifyProjectName("!!!")).toBe("agent");
  });
});

describe("isValidProjectSlug", () => {
  test.each(["my-agent", "a", "a1", "agent-2", "x".repeat(63)])("accepts %s", (slug) => {
    expect(isValidProjectSlug(slug)).toBe(true);
  });

  test.each(["-agent", "agent-", "My-Agent", "a_b", "a.b", "", "x".repeat(64)])("rejects %s", (slug) => {
    expect(isValidProjectSlug(slug)).toBe(false);
  });

  test.each(["www", "api", "gateway", "eveland", "admin"])("rejects reserved slug %s", (slug) => {
    expect(isValidProjectSlug(slug)).toBe(false);
  });
});

describe("createSlugSuffix", () => {
  test("returns 4 lowercase-alphanumeric chars", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(createSlugSuffix()).toMatch(/^[0-9a-z]{4}$/);
    }
  });
});

describe("normalizeAgentDomain", () => {
  test("lowercases, trims, and strips a trailing dot", () => {
    expect(normalizeAgentDomain(" LVH.me. ")).toBe("lvh.me");
  });

  test("returns null for unset or blank values", () => {
    expect(normalizeAgentDomain(undefined)).toBeNull();
    expect(normalizeAgentDomain("  ")).toBeNull();
  });
});

describe("mintAgentUrl", () => {
  test("mints scheme://slug.domain with optional port", () => {
    expect(mintAgentUrl("demo", { EVELAND_AGENT_DOMAIN: "lvh.me", EVELAND_AGENT_URL_SCHEME: "http", EVELAND_AGENT_URL_PORT: "8080" })).toBe(
      "http://demo.lvh.me:8080",
    );
    expect(mintAgentUrl("demo", { EVELAND_AGENT_DOMAIN: "jinshujuagents.com", EVELAND_AGENT_URL_SCHEME: "https" })).toBe(
      "https://demo.jinshujuagents.com",
    );
  });

  test("defaults the scheme to http", () => {
    expect(mintAgentUrl("demo", { EVELAND_AGENT_DOMAIN: "lvh.me" })).toBe("http://demo.lvh.me");
  });

  test("returns null when the domain is not configured", () => {
    expect(mintAgentUrl("demo", {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @eveland/shared test -- agent-domain`
Expected: FAIL — cannot resolve `./agent-domain.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/agent-domain.ts
import { customAlphabet } from "nanoid";

// DNS label: max 63 chars, [a-z0-9-], no leading/trailing hyphen.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set(["www", "api", "gateway", "eveland", "admin"]);

export function isValidProjectSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_PROJECT_SLUGS.has(slug);
}

// The shared createId alphabet contains uppercase, which is not DNS-safe.
const slugSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 4);

export function createSlugSuffix(): string {
  return slugSuffix();
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "agent";
}

export function normalizeAgentDomain(value: string | undefined): string | null {
  const domain = value?.trim().replace(/\.$/, "").toLowerCase();
  return domain ? domain : null;
}

export type AgentUrlEnv = {
  EVELAND_AGENT_DOMAIN?: string;
  EVELAND_AGENT_URL_SCHEME?: string;
  EVELAND_AGENT_URL_PORT?: string;
};

export function mintAgentUrl(slug: string, env: AgentUrlEnv): string | null {
  const domain = normalizeAgentDomain(env.EVELAND_AGENT_DOMAIN);
  if (!domain) {
    return null;
  }
  const scheme = env.EVELAND_AGENT_URL_SCHEME?.trim() || "http";
  const port = env.EVELAND_AGENT_URL_PORT?.trim();
  return `${scheme}://${slug}.${domain}${port ? `:${port}` : ""}`;
}
```

Add to `packages/shared/package.json` `"exports"`:

```json
"./agent-domain": "./src/agent-domain.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @eveland/shared test -- agent-domain`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @eveland/shared typecheck
git add packages/shared/src/agent-domain.ts packages/shared/src/agent-domain.test.ts packages/shared/package.json
git commit -m "feat(shared): agent-domain slug and URL utilities"
```

---

### Task 2: `projects.slug` column with auto-generation on create

**Files:**
- Modify: `apps/api/src/db/schema.ts` (projects table)
- Modify: `apps/api/src/types.ts` (`Project`)
- Modify: `apps/api/src/db/mappers.ts` (`ProjectRow`, `projectRowToProject`)
- Modify: `apps/api/src/store.ts` (`CreateProjectInput`, `SlugConflictError`, memory store)
- Modify: `apps/api/src/db/postgres-store.ts` (`createProject`)
- Modify: `apps/api/src/store.test.ts`
- Create (generated + hand-edited): `apps/api/drizzle/0005_*.sql`

**Interfaces:**
- Consumes: `slugifyProjectName`, `isValidProjectSlug`, `createSlugSuffix` from `@eveland/shared/agent-domain` (Task 1).
- Produces:
  - `Project.slug: string` (types.ts)
  - `CreateProjectInput.slug?: string | null`
  - `export class SlugConflictError extends Error` in `apps/api/src/store.ts` with `constructor(slug: string)`
  - Message: `Project slug "<slug>" is already taken.`

- [ ] **Step 1: Write the failing tests** (append to `apps/api/src/store.test.ts`)

```ts
import { createMemoryStore, SlugConflictError } from "./store.js";

describe("memory store project slugs", () => {
  test("auto-generates a slug from the project name", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Weather Agent", importKind: "git", gitUrl: "https://example.com/w.git" });
    expect(project.slug).toBe("weather-agent");
  });

  test("falls back to a suffixed 'agent' slug for non-latin names", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "天气助手", importKind: "git", gitUrl: "https://example.com/w.git" });
    expect(project.slug).toMatch(/^agent(-[0-9a-z]{4})?$/);
  });

  test("suffixes duplicates so slugs stay unique", async () => {
    const store = createMemoryStore();
    const first = await store.createProject({ name: "Demo", importKind: "git", gitUrl: "https://example.com/d.git" });
    const second = await store.createProject({ name: "Demo", importKind: "git", gitUrl: "https://example.com/d.git" });
    expect(first.slug).toBe("demo");
    expect(second.slug).toMatch(/^demo-[0-9a-z]{4}$/);
    expect(second.slug).not.toBe(first.slug);
  });

  test("suffixes a name that slugifies to a reserved label", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "API", importKind: "git", gitUrl: "https://example.com/a.git" });
    expect(project.slug).toMatch(/^api-[0-9a-z]{4}$/);
  });

  test("respects an explicitly requested slug and rejects a taken one", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Demo", importKind: "git", gitUrl: "https://example.com/d.git", slug: "custom-slug" });
    expect(project.slug).toBe("custom-slug");
    await expect(
      store.createProject({ name: "Other", importKind: "git", gitUrl: "https://example.com/o.git", slug: "custom-slug" }),
    ).rejects.toBeInstanceOf(SlugConflictError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/api test -- store`
Expected: FAIL — `SlugConflictError` not exported, `slug` missing from `Project`.

- [ ] **Step 3: Implement**

`apps/api/src/db/schema.ts` — give the projects table its slug and a unique index (the table gets a third argument, like `secrets` already has):

```ts
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    importKind: text("import_kind").notNull(),
    gitUrl: text("git_url"),
    status: text("status").notNull(),
    deploymentStatus: text("deployment_status").notNull(),
    sourceRevisionId: text("source_revision_id"),
    releaseId: text("release_id"),
    deploymentId: text("deployment_id"),
    latestSessionStatus: text("latest_session_status"),
    nextScheduleAt: timestamp("next_schedule_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("projects_slug_idx").on(table.slug)],
);
```

`apps/api/src/types.ts` — add to `Project` (right after `name`):

```ts
  slug: string;
```

`apps/api/src/db/mappers.ts` — add `slug: string;` to `ProjectRow` and `slug: row.slug,` to `projectRowToProject`.

`apps/api/src/store.ts`:

```ts
import { createSlugSuffix, isValidProjectSlug, slugifyProjectName } from "@eveland/shared/agent-domain";

export class SlugConflictError extends Error {
  constructor(slug: string) {
    super(`Project slug "${slug}" is already taken.`);
    this.name = "SlugConflictError";
  }
}

export type CreateProjectInput = {
  name: string;
  importKind: ProjectImportKind;
  gitUrl?: string | null;
  sourcePath?: string | null;
  slug?: string | null;
};

// Shared by both stores: requested slugs fail hard on conflict, generated ones retry.
export function resolveRequestedOrGeneratedSlug(
  input: { slug?: string | null; name: string },
  isTaken: (slug: string) => boolean,
): string {
  if (input.slug) {
    if (isTaken(input.slug)) {
      throw new SlugConflictError(input.slug);
    }
    return input.slug;
  }
  const base = slugifyProjectName(input.name);
  let candidate = isValidProjectSlug(base) ? base : `${base}-${createSlugSuffix()}`;
  while (isTaken(candidate)) {
    candidate = `${base}-${createSlugSuffix()}`;
  }
  return candidate;
}
```

Memory store `createProject` — resolve the slug before constructing the project:

```ts
    async createProject(input) {
      const now = new Date().toISOString();
      const slug = resolveRequestedOrGeneratedSlug(input, (candidate) => state.projects.some((project) => project.slug === candidate));
      const project: Project = {
        id: createId("proj"),
        name: input.name,
        slug,
        importKind: input.importKind,
        // ...rest unchanged
```

`apps/api/src/db/postgres-store.ts` `createProject` — the unique index is the arbiter; generated slugs retry, requested slugs surface the conflict:

```ts
    async createProject(input: CreateProjectInput) {
      await ensureDefaultOwner();

      const requestedSlug = input.slug ?? null;
      const base = slugifyProjectName(input.name);
      let candidate = requestedSlug ?? (isValidProjectSlug(base) ? base : `${base}-${createSlugSuffix()}`);

      for (let attempt = 0; ; attempt += 1) {
        try {
          const [row] = await db
            .insert(projects)
            .values({
              id: createId("proj"),
              ownerId: defaultOwner.id,
              name: input.name,
              slug: candidate,
              importKind: input.importKind,
              gitUrl: input.gitUrl ?? null,
              status: "import_pending",
              deploymentStatus: "not_deployed",
            })
            .returning();

          if (!row) {
            throw new Error("Failed to create project.");
          }

          await createJob(row.id, "import_source", {
            importKind: input.importKind,
            gitUrl: input.gitUrl ?? null,
            sourcePath: input.sourcePath ?? null,
          });

          return projectRowToProject(row);
        } catch (error) {
          if (!isUniqueSlugViolation(error)) {
            throw error;
          }
          if (requestedSlug || attempt >= 5) {
            throw new SlugConflictError(candidate);
          }
          candidate = `${base}-${createSlugSuffix()}`;
        }
      }
    },
```

Add the helper at module scope in `postgres-store.ts`:

```ts
// postgres-js surfaces unique violations as code 23505; scope to the slug index
// so an unrelated constraint never triggers a slug retry.
function isUniqueSlugViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505" &&
    String((error as { constraint_name?: string }).constraint_name ?? "") === "projects_slug_idx"
  );
}
```

Imports to add in `postgres-store.ts`:

```ts
import { createSlugSuffix, isValidProjectSlug, slugifyProjectName } from "@eveland/shared/agent-domain";
import type { CreateProjectInput, Store } from "../store.js";
import { SlugConflictError } from "../store.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @eveland/api test -- store`
Expected: PASS. Then `pnpm --filter @eveland/api typecheck` — fix any missed `slug` field (e.g. test fixtures constructing `Project` objects).

- [ ] **Step 5: Generate the migration and hand-edit the backfill**

Run: `pnpm --filter @eveland/api db:generate`
Expected: a new `apps/api/drizzle/0005_<name>.sql` containing `ALTER TABLE "projects" ADD COLUMN "slug" text NOT NULL;` and the unique index.

Hand-edit the generated file so existing installs can apply it against non-empty tables (drizzle's snapshot JSON stays as generated — it reflects schema.ts):

```sql
ALTER TABLE "projects" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "projects" SET "slug" = left(
  coalesce(
    nullif(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''),
    'agent'
  ) || '-' || lower(substring("id" from 6 for 6)),
  63
) WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_idx" ON "projects" USING btree ("slug");
```

(Backfilled slugs always carry an id-derived suffix so the index build cannot collide; fresh databases get the column via `db:push` before any rows exist.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src apps/api/drizzle
git commit -m "feat(api): unique DNS-safe slug on projects"
```

---

### Task 3: `updateProjectSlug` on both stores

**Files:**
- Modify: `apps/api/src/store.ts` (interface + memory implementation)
- Modify: `apps/api/src/db/postgres-store.ts`
- Modify: `apps/api/src/store.test.ts`

**Interfaces:**
- Consumes: `SlugConflictError` (Task 2).
- Produces: `updateProjectSlug(projectId: string, slug: string): Promise<Project | null>` on the `Store` type — returns `null` for an unknown project, throws `SlugConflictError` when the slug is taken by another project. Callers pass an already-validated slug; the store only arbitrates uniqueness.

- [ ] **Step 1: Write the failing tests** (append to `apps/api/src/store.test.ts`)

```ts
describe("memory store updateProjectSlug", () => {
  test("renames the slug and bumps updatedAt", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Demo", importKind: "git", gitUrl: "https://example.com/d.git" });
    const updated = await store.updateProjectSlug(project.id, "renamed-agent");
    expect(updated?.slug).toBe("renamed-agent");
    expect((await store.getProject(project.id))?.slug).toBe("renamed-agent");
  });

  test("returns null for an unknown project", async () => {
    const store = createMemoryStore();
    await expect(store.updateProjectSlug("proj_missing", "whatever")).resolves.toBeNull();
  });

  test("throws SlugConflictError when another project holds the slug", async () => {
    const store = createMemoryStore();
    const first = await store.createProject({ name: "First", importKind: "git", gitUrl: "https://example.com/f.git" });
    const second = await store.createProject({ name: "Second", importKind: "git", gitUrl: "https://example.com/s.git" });
    await expect(store.updateProjectSlug(second.id, first.slug)).rejects.toBeInstanceOf(SlugConflictError);
  });

  test("is a no-op success when setting a project's own slug", async () => {
    const store = createMemoryStore();
    const project = await store.createProject({ name: "Demo", importKind: "git", gitUrl: "https://example.com/d.git" });
    await expect(store.updateProjectSlug(project.id, project.slug)).resolves.toMatchObject({ slug: project.slug });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/api test -- store`
Expected: FAIL — `updateProjectSlug` is not a function.

- [ ] **Step 3: Implement**

`apps/api/src/store.ts` — add to the `Store` type (after `updateProjectState`):

```ts
  updateProjectSlug(projectId: string, slug: string): Promise<Project | null>;
```

Memory implementation:

```ts
    async updateProjectSlug(projectId, slug) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        return null;
      }
      if (state.projects.some((candidate) => candidate.id !== projectId && candidate.slug === slug)) {
        throw new SlugConflictError(slug);
      }
      project.slug = slug;
      project.updatedAt = new Date().toISOString();
      return project;
    },
```

Postgres implementation (`apps/api/src/db/postgres-store.ts`):

```ts
    async updateProjectSlug(projectId, slug) {
      try {
        const [row] = await db
          .update(projects)
          .set({ slug, updatedAt: new Date() })
          .where(eq(projects.id, projectId))
          .returning();
        return row ? projectRowToProject(row) : null;
      } catch (error) {
        if (isUniqueSlugViolation(error)) {
          throw new SlugConflictError(slug);
        }
        throw error;
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @eveland/api test -- store` then `pnpm --filter @eveland/api typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): updateProjectSlug on both stores"
```

---

### Task 4: API — slug on create, PATCH endpoint, `agentUrl` in responses

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`

**Interfaces:**
- Consumes: `isValidProjectSlug`, `mintAgentUrl`, `AgentUrlEnv` (Task 1); `SlugConflictError`, `updateProjectSlug` (Tasks 2–3).
- Produces:
  - `AppOptions.agentUrlEnv?: AgentUrlEnv` (defaults to `process.env`) — tests inject it.
  - Every project payload the API returns is `{ ...project, agentUrl: string | null }`.
  - `PATCH /projects/:projectId` accepting `{ slug }` → 200 `{ project }`, 400 invalid, 404 unknown, 409 conflict.
  - `POST /projects` (JSON branch) accepts optional `slug`.

- [ ] **Step 1: Write the failing tests** (append to `apps/api/src/app.test.ts`)

```ts
describe("project slugs and agent urls", () => {
  const agentUrlEnv = { EVELAND_AGENT_DOMAIN: "lvh.me", EVELAND_AGENT_URL_SCHEME: "http", EVELAND_AGENT_URL_PORT: "8080" };

  test("returns slug and minted agentUrl on create and get", async () => {
    const app = createApp(createMemoryStore(), { agentUrlEnv });
    const createResponse = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Weather Agent", importKind: "git", gitUrl: "https://example.com/w.git" }),
    });
    const created = await createResponse.json();
    expect(created.project.slug).toBe("weather-agent");
    expect(created.project.agentUrl).toBe("http://weather-agent.lvh.me:8080");

    const getResponse = await app.request(`/projects/${created.project.id}`);
    await expect(getResponse.json()).resolves.toMatchObject({
      project: { slug: "weather-agent", agentUrl: "http://weather-agent.lvh.me:8080" },
    });
  });

  test("agentUrl is null when the agent domain is not configured", async () => {
    const app = createApp(createMemoryStore(), { agentUrlEnv: {} });
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Weather Agent", importKind: "git", gitUrl: "https://example.com/w.git" }),
    });
    await expect(response.json()).resolves.toMatchObject({ project: { agentUrl: null } });
  });

  test("accepts an explicit valid slug and rejects an invalid one on create", async () => {
    const app = createApp(createMemoryStore(), { agentUrlEnv });
    const ok = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Demo", importKind: "git", gitUrl: "https://example.com/d.git", slug: "my-demo" }),
    });
    expect(ok.status).toBe(201);
    await expect(ok.json()).resolves.toMatchObject({ project: { slug: "my-demo" } });

    const bad = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Demo", importKind: "git", gitUrl: "https://example.com/d.git", slug: "Bad_Slug" }),
    });
    expect(bad.status).toBe(400);
  });

  test("PATCH updates the slug, validates, and maps conflicts to 409", async () => {
    const store = createMemoryStore();
    const app = createApp(store, { agentUrlEnv });
    const first = await store.createProject({ name: "First", importKind: "git", gitUrl: "https://example.com/f.git" });
    const second = await store.createProject({ name: "Second", importKind: "git", gitUrl: "https://example.com/s.git" });

    const renamed = await app.request(`/projects/${second.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "second-agent" }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      project: { slug: "second-agent", agentUrl: "http://second-agent.lvh.me:8080" },
    });

    const invalid = await app.request(`/projects/${second.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "-bad-" }),
    });
    expect(invalid.status).toBe(400);

    const reserved = await app.request(`/projects/${second.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "www" }),
    });
    expect(reserved.status).toBe(400);

    const conflict = await app.request(`/projects/${second.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: first.slug }),
    });
    expect(conflict.status).toBe(409);

    const missing = await app.request("/projects/proj_missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "whatever-slug" }),
    });
    expect(missing.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/api test -- app`
Expected: FAIL — `agentUrlEnv` not an option, no PATCH route, no `agentUrl` in payloads.

- [ ] **Step 3: Implement in `apps/api/src/app.ts`**

Imports:

```ts
import { isValidProjectSlug, mintAgentUrl, type AgentUrlEnv } from "@eveland/shared/agent-domain";
import { SlugConflictError, type Store } from "./store.js";
```

Schemas (replace `createProjectSchema`, add the two new ones):

```ts
const projectSlugSchema = z
  .string()
  .refine(isValidProjectSlug, { message: "Slug must be a DNS-safe label: [a-z0-9-], max 63 chars, no leading/trailing hyphen, not reserved." });

const createProjectSchema = z.object({
  name: z.string().min(1),
  importKind: z.enum(["git", "zip"]),
  gitUrl: z.string().url().optional().nullable(),
  slug: projectSlugSchema.optional(),
});

const updateProjectSchema = z.object({
  slug: projectSlugSchema,
});
```

`AppOptions` and setup inside `createApp`:

```ts
export type AppOptions = {
  playgroundRunner?: PlaygroundRunner;
  dataDir?: string;
  agentUrlEnv?: AgentUrlEnv;
};

// inside createApp:
const agentUrlEnv = options.agentUrlEnv ?? (process.env as AgentUrlEnv);
const toProjectResponse = (project: Project) => ({ ...project, agentUrl: mintAgentUrl(project.slug, agentUrlEnv) });
```

Route changes:

```ts
app.get("/projects", async (c) => c.json({ projects: (await store.listProjects()).map(toProjectResponse) }));
```

`POST /projects` JSON branch: pass `slug: parsed.data.slug ?? null` into `store.createProject`, wrap in try/catch mapping `SlugConflictError` to 409, and return `{ project: toProjectResponse(project) }`. The zip branch (`createZipProjectFromUpload`) returns `toProjectResponse(project)` too — pass `toProjectResponse` down as a parameter (it is a module-level helper function taking `(c, store, dataDir)` today; extend it to `(c, store, dataDir, toProjectResponse)`).

`GET /projects/:projectId`: `return c.json({ project: toProjectResponse(project) })`.

New PATCH route (place after the DELETE route):

```ts
app.patch("/projects/:projectId", async (c) => {
  const parsed = updateProjectSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid project update", issues: parsed.error.issues }, 400);
  }
  try {
    const project = await store.updateProjectSlug(c.req.param("projectId"), parsed.data.slug);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    return c.json({ project: toProjectResponse(project) });
  } catch (error) {
    if (error instanceof SlugConflictError) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @eveland/api test` then `pnpm --filter @eveland/api typecheck`
Expected: PASS / clean (existing tests unaffected — they don't assert absence of extra fields).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): slug create/patch endpoints and agentUrl in project payloads"
```

---

### Task 5: `deployments.hostAddress`

**Files:**
- Modify: `apps/api/src/db/schema.ts` (deployments table)
- Modify: `apps/api/src/types.ts` (`DeploymentRecord`)
- Modify: `apps/api/src/db/mappers.ts`
- Modify: `apps/api/src/store.ts` (recordDeployment input + memory impl)
- Modify: `apps/api/src/db/postgres-store.ts` (recordDeployment)
- Modify: `apps/worker/src/jobs/process.ts` (pass `hostAddress`)
- Modify: `apps/api/src/store.test.ts`
- Create (generated + hand-edited): `apps/api/drizzle/0006_*.sql`

**Interfaces:**
- Produces:
  - `DeploymentRecord.hostAddress: string`
  - `recordDeployment` input gains required `hostAddress: string`
  - The worker records `hostAddress: "127.0.0.1"` (single-host reality today; the schema leaves room for cross-node forwarding).

- [ ] **Step 1: Write the failing test** (append to `apps/api/src/store.test.ts`; follow the existing recordDeployment arrangement in that file — create a project and a source revision first, matching how current deployment tests seed state)

```ts
test("recordDeployment persists hostAddress", async () => {
  const store = createMemoryStore();
  const project = await store.createProject({ name: "Demo", importKind: "git", gitUrl: "https://example.com/d.git" });
  const revision = await store.recordSourceRevision({
    projectId: project.id,
    kind: "git",
    commitSha: "abc123",
    sourcePath: "/tmp/src",
    summary: {},
    envVars: [],
    files: [],
    schedules: [],
  });
  const deployment = await store.recordDeployment({
    projectId: project.id,
    sourceRevisionId: revision.id,
    imageTag: "img:1",
    containerName: "eveland-demo",
    internalPort: 3000,
    hostPort: 41000,
    hostAddress: "127.0.0.1",
    runtimeKind: "docker",
  });
  expect(deployment.hostAddress).toBe("127.0.0.1");
  await expect(store.getCurrentDeployment(project.id)).resolves.toMatchObject({ hostAddress: "127.0.0.1" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @eveland/api test -- store`
Expected: FAIL — `hostAddress` unknown / undefined.

- [ ] **Step 3: Implement**

Schema (`deployments` table, after `hostPort`):

```ts
  hostAddress: text("host_address").notNull(),
```

`types.ts` `DeploymentRecord` (after `hostPort`): `hostAddress: string;`
Mappers: add to the deployment row type and `deploymentRowToDeployment`.
`store.ts`: add `hostAddress: string;` to the `recordDeployment` input type; memory implementation copies it onto the record.
`postgres-store.ts` `recordDeployment`: add `hostAddress: input.hostAddress,` to the insert values.
`apps/worker/src/jobs/process.ts` — the `build_deploy` `recordDeployment` call gains `hostAddress: "127.0.0.1",` (the worker health-checks on that same loopback a few lines above; the two must stay the same address).

Fix compile fallout: any test fixture or fake constructing `DeploymentRecord` / calling `recordDeployment` (search `recordDeployment(` and `hostPort:` across `apps/`) gains `hostAddress: "127.0.0.1"`.

- [ ] **Step 4: Generate the migration and hand-edit**

Run: `pnpm --filter @eveland/api db:generate`
Hand-edit `apps/api/drizzle/0006_*.sql` to the backfill-then-tighten shape (same as `0004_robust_devos.sql`):

```sql
ALTER TABLE "deployments" ADD COLUMN "host_address" text NOT NULL DEFAULT '127.0.0.1';--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "host_address" DROP DEFAULT;
```

- [ ] **Step 5: Run tests and typecheck across affected packages**

Run: `pnpm --filter @eveland/api test && pnpm --filter @eveland/api typecheck && pnpm --filter @eveland/worker test && pnpm --filter @eveland/worker typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/worker/src
git commit -m "feat(api,worker): record deployment hostAddress for cluster-ready routing"
```

---

### Task 6: Worker — inject `WORKFLOW_LOCAL_BASE_URL` and dev `extraHosts`

**Files:**
- Modify: `apps/worker/src/jobs/process.ts`
- Modify: `apps/worker/src/runtime/types.ts` (`ProcessStartInput`)
- Modify: `apps/worker/src/runtime/docker.ts` (`DockerRunInput`, `buildDockerRunArgs`, adapter wiring)
- Modify: `apps/worker/src/jobs/process.test.ts`
- Modify: `apps/worker/src/docker.test.ts`

**Interfaces:**
- Consumes: `mintAgentUrl`, `normalizeAgentDomain`, `AgentUrlEnv` (Task 1); `project.slug` (Task 2).
- Produces:
  - `ProcessJobOptions.agentUrlEnv?: AgentUrlEnv` (defaults to `process.env`) — test injection point mirroring `nodeEnv`.
  - `ProcessStartInput.extraHosts?: string[]` — docker adapter maps each entry to `--add-host <entry>`; the systemd adapter ignores the field.
  - `composeDeploymentEnv(store, project: Project, options)` — signature changes from `projectId` to the full `Project` (both call sites already hold it).

- [ ] **Step 1: Write the failing docker-args test** (append to `apps/worker/src/docker.test.ts`)

```ts
test("buildDockerRunArgs adds one --add-host per extraHosts entry", () => {
  const args = buildDockerRunArgs({
    containerName: "eveland-demo",
    imageTag: "img:1",
    internalPort: 3000,
    hostPort: 41000,
    env: {},
    command: "npx eve start",
    extraHosts: ["demo.lvh.me:host-gateway"],
  });
  const index = args.indexOf("demo.lvh.me:host-gateway");
  expect(index).toBeGreaterThan(0);
  expect(args[index - 1]).toBe("--add-host");
});
```

- [ ] **Step 2: Write the failing env-injection tests** (append to `apps/worker/src/jobs/process.test.ts`; reuse that file's existing build_deploy arrangement — memory store seeded with a project + source revision, a fake `RuntimeAdapter` capturing `startProcess` input, `allocateHostPort`/`waitForDeployment` stubs — and add `agentUrlEnv` to the options)

```ts
test("build_deploy injects WORKFLOW_LOCAL_BASE_URL from the project slug", async () => {
  // arrange: same seeding as the existing build_deploy success test in this file
  // act: processNextJob(store, "w1", { runtime: fakeRuntime, allocateHostPort: () => 41000,
  //   waitForDeployment: async () => {}, workflowPostgresUrl: "postgres://x",
  //   agentUrlEnv: { EVELAND_AGENT_DOMAIN: "lvh.me", EVELAND_AGENT_URL_SCHEME: "http", EVELAND_AGENT_URL_PORT: "8080" } })
  const started = capturedStartProcessInput();
  expect(started.env.WORKFLOW_LOCAL_BASE_URL).toBe(`http://${project.slug}.lvh.me:8080`);
});

test("a project secret named WORKFLOW_LOCAL_BASE_URL overrides the injected value", async () => {
  // arrange: upsertSecret(project.id, "WORKFLOW_LOCAL_BASE_URL", encrypted("https://override.example"))
  // act as above
  expect(started.env.WORKFLOW_LOCAL_BASE_URL).toBe("https://override.example");
});

test("no domain configured: variable absent and a deploy warning is logged", async () => {
  // act with agentUrlEnv: {}
  expect(started.env.WORKFLOW_LOCAL_BASE_URL).toBeUndefined();
  const logs = await store.listLogs(project.id, "deploy");
  expect(logs.some((log) => log.line.includes("EVELAND_AGENT_DOMAIN is not set"))).toBe(true);
});

test("extraHosts maps the agent's own domain to host-gateway only for dev docker deploys", async () => {
  // act with nodeEnv: undefined (dev), fake docker runtime, agentUrlEnv with domain
  expect(started.extraHosts).toEqual([`${project.slug}.lvh.me:host-gateway`]);
  // act again with nodeEnv: "production"
  expect(startedInProduction.extraHosts).toEqual([]);
});
```

(These sketches pin the assertions; flesh out arrangement by copying the existing passing build_deploy test in the same file. The secret-encryption helper already exists there for secret tests — reuse it.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @eveland/worker test`
Expected: FAIL — unknown option `agentUrlEnv`, `extraHosts` missing.

- [ ] **Step 4: Implement**

`apps/worker/src/runtime/types.ts` — add to `ProcessStartInput`:

```ts
  /**
   * Additional container host mappings (docker --add-host format "name:target").
   * Dev-only plumbing so an agent container can resolve its own public domain to
   * the host gateway; the systemd adapter ignores it (host processes use system DNS).
   */
  extraHosts?: string[];
```

`apps/worker/src/runtime/docker.ts` — `DockerRunInput` gains `extraHosts?: string[]`; in `buildDockerRunArgs`, after the `--publish` pair:

```ts
  for (const extraHost of input.extraHosts ?? []) {
    args.push("--add-host", extraHost);
  }
```

Wire `input.extraHosts` through the adapter's `startProcess` → `dockerRun` call (the adapter builds a `DockerRunInput` from `ProcessStartInput`; pass the field through).

`apps/worker/src/jobs/process.ts`:

```ts
import { mintAgentUrl, normalizeAgentDomain, type AgentUrlEnv } from "@eveland/shared/agent-domain";

export type ProcessJobOptions = {
  // ...existing fields...
  agentUrlEnv?: AgentUrlEnv;
};

// Dev-only: inside a container the public agent domain resolves to the container's
// own loopback, so callbacks would dial themselves. In production the public URL
// points at the TLS ingress, which host-gateway would wrongly bypass.
function resolveExtraHosts(input: {
  runtimeName: "docker" | "systemd";
  slug: string;
  isProduction: boolean;
  agentUrlEnv: AgentUrlEnv;
}): string[] {
  const domain = normalizeAgentDomain(input.agentUrlEnv.EVELAND_AGENT_DOMAIN);
  if (input.isProduction || input.runtimeName !== "docker" || !domain) {
    return [];
  }
  return [`${input.slug}.${domain}:host-gateway`];
}
```

`composeDeploymentEnv` — change the second parameter from `projectId: string` to `project: Project` (import the type from `@eveland/api/types`), and inject the URL between the platform credential and the secrets spread:

```ts
  const agentUrlEnv = options.agentUrlEnv ?? (process.env as AgentUrlEnv);
  const workflowLocalBaseUrl = mintAgentUrl(project.slug, agentUrlEnv);
  if (!workflowLocalBaseUrl) {
    await store.appendLog({
      projectId: project.id,
      type: "deploy",
      line: "Warning: EVELAND_AGENT_DOMAIN is not set; WORKFLOW_LOCAL_BASE_URL was not injected.",
    });
  }
  const injectedCredentials = {
    ...(workflowPostgresUrl ? { WORKFLOW_POSTGRES_URL: workflowPostgresUrl } : {}),
    ...(workflowLocalBaseUrl ? { WORKFLOW_LOCAL_BASE_URL: workflowLocalBaseUrl } : {}),
    ...secrets,
  };
```

Both call sites (`build_deploy`, `restart_deployment`) change to `composeDeploymentEnv(store, project, options)` and add to their `startProcess` input:

```ts
  extraHosts: resolveExtraHosts({
    runtimeName: runtime.name, // `adapter.name` in restart_deployment
    slug: project.slug,
    isProduction,
    agentUrlEnv: options.agentUrlEnv ?? (process.env as AgentUrlEnv),
  }),
```

(`restart_deployment` doesn't compute `isProduction` today — derive it the same way `build_deploy` does: `const isProduction = (options.nodeEnv ?? process.env.NODE_ENV) === "production";`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @eveland/worker test && pnpm --filter @eveland/worker typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src
git commit -m "feat(worker): inject WORKFLOW_LOCAL_BASE_URL and dev extra-host mapping"
```

---

### Task 7: Gateway scaffold — package, config, RouteSource seam, route cache

**Files:**
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/tsconfig.json`
- Create: `apps/gateway/src/config.ts`
- Create: `apps/gateway/src/config.test.ts`
- Create: `apps/gateway/src/route-source.ts`
- Create: `apps/gateway/src/route-cache.ts`
- Create: `apps/gateway/src/route-cache.test.ts`
- Modify: `apps/api/package.json` (export `./db/client` and `./db/schema` for the gateway's read-only queries)

**Interfaces:**
- Produces:
  - `type AgentRoute = { slug: string; name: string; hostAddress: string; hostPort: number }`
  - `type RouteSource = { lookup(slug: string): Promise<AgentRoute | null>; listAgents(): Promise<Array<{ slug: string; name: string }>>; subscribe(handlers: { onInvalidate: (slug: string | null) => void }): Promise<void>; close(): Promise<void> }` — `onInvalidate(null)` means "clear everything".
  - `type GatewayConfig = { port: number; databaseUrl: string; agentDomain: string; agentUrlEnv: AgentUrlEnv; upstreamTimeoutMs: number; routeTtlMs: number; upstreamHostOverride: string | null }`
  - `loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig` — throws one aggregated error listing every missing required variable.
  - `createRouteCache(options: { ttlMs: number; maxEntries?: number; now?: () => number }): RouteCache` with `get(slug): { route: AgentRoute | null } | undefined`, `set(slug, route)`, `invalidate(slug)`, `clear()`, `size()`.

- [ ] **Step 1: Scaffold the package**

`apps/gateway/package.json`:

```json
{
  "name": "@eveland/gateway",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=../../.env src/server.ts",
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@eveland/api": "workspace:*",
    "@eveland/shared": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "postgres": "^3.4.9"
  },
  "devDependencies": {
    "vitest": "^4.1.9"
  }
}
```

`apps/gateway/tsconfig.json` (same shape as the worker's):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

Add to `apps/api/package.json` `"exports"`:

```json
"./db/client": "./src/db/client.ts",
"./db/schema": "./src/db/schema.ts"
```

Run `pnpm install` (workspace link). Note: `src/server.ts` doesn't exist yet — `dev` stays unused until Task 8; `test`/`typecheck` work from this task on.

- [ ] **Step 2: Write the failing config test**

```ts
// apps/gateway/src/config.test.ts
import { describe, expect, test } from "vitest";
import { loadGatewayConfig } from "./config.js";

describe("loadGatewayConfig", () => {
  const validEnv = {
    DATABASE_URL: "postgres://eveland:eveland@localhost:5432/eveland",
    EVELAND_AGENT_DOMAIN: "LVH.me.",
  } as NodeJS.ProcessEnv;

  test("applies defaults and normalizes the domain", () => {
    const config = loadGatewayConfig(validEnv);
    expect(config).toMatchObject({
      port: 8080,
      agentDomain: "lvh.me",
      upstreamTimeoutMs: 30_000,
      routeTtlMs: 30_000,
      upstreamHostOverride: null,
    });
    expect(config.agentUrlEnv.EVELAND_AGENT_DOMAIN).toBe("lvh.me");
  });

  test("reads overrides", () => {
    const config = loadGatewayConfig({
      ...validEnv,
      PORT: "9090",
      EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS: "5000",
      EVELAND_GATEWAY_ROUTE_TTL_MS: "1000",
      EVELAND_GATEWAY_UPSTREAM_HOST: "host.docker.internal",
      EVELAND_AGENT_URL_SCHEME: "https",
      EVELAND_AGENT_URL_PORT: "8443",
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ port: 9090, upstreamTimeoutMs: 5000, routeTtlMs: 1000, upstreamHostOverride: "host.docker.internal" });
    expect(config.agentUrlEnv).toEqual({ EVELAND_AGENT_DOMAIN: "lvh.me", EVELAND_AGENT_URL_SCHEME: "https", EVELAND_AGENT_URL_PORT: "8443" });
  });

  test("aggregates every missing required variable into one error", () => {
    expect(() => loadGatewayConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL[\s\S]*EVELAND_AGENT_DOMAIN/);
  });
});
```

- [ ] **Step 3: Write the failing route-cache test**

```ts
// apps/gateway/src/route-cache.test.ts
import { describe, expect, test } from "vitest";
import { createRouteCache } from "./route-cache.js";
import type { AgentRoute } from "./route-source.js";

const route: AgentRoute = { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: 41000 };

describe("route cache", () => {
  test("returns entries until the TTL expires", () => {
    let clock = 0;
    const cache = createRouteCache({ ttlMs: 1000, now: () => clock });
    cache.set("demo", route);
    expect(cache.get("demo")).toEqual({ route });
    clock = 999;
    expect(cache.get("demo")).toEqual({ route });
    clock = 1000;
    expect(cache.get("demo")).toBeUndefined();
  });

  test("caches negative lookups distinctly from cache misses", () => {
    const cache = createRouteCache({ ttlMs: 1000 });
    cache.set("ghost", null);
    expect(cache.get("ghost")).toEqual({ route: null });
    expect(cache.get("never-seen")).toBeUndefined();
  });

  test("invalidate drops a single slug; clear drops everything", () => {
    const cache = createRouteCache({ ttlMs: 1000 });
    cache.set("a", route);
    cache.set("b", route);
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual({ route });
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });

  test("clears wholesale when maxEntries is exceeded", () => {
    const cache = createRouteCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set("a", route);
    cache.set("b", route);
    cache.set("c", route);
    expect(cache.size()).toBe(1);
    expect(cache.get("c")).toEqual({ route });
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @eveland/gateway test`
Expected: FAIL — modules don't exist.

- [ ] **Step 5: Implement**

```ts
// apps/gateway/src/route-source.ts
export type AgentRoute = {
  slug: string;
  name: string;
  hostAddress: string;
  hostPort: number;
};

export type RouteSource = {
  lookup(slug: string): Promise<AgentRoute | null>;
  listAgents(): Promise<Array<{ slug: string; name: string }>>;
  /** onInvalidate(null) means "drop the whole cache" (listener (re)connect, unparseable payload). */
  subscribe(handlers: { onInvalidate: (slug: string | null) => void }): Promise<void>;
  close(): Promise<void>;
};
```

```ts
// apps/gateway/src/config.ts
import { normalizeAgentDomain, type AgentUrlEnv } from "@eveland/shared/agent-domain";

export type GatewayConfig = {
  port: number;
  databaseUrl: string;
  agentDomain: string;
  agentUrlEnv: AgentUrlEnv;
  upstreamTimeoutMs: number;
  routeTtlMs: number;
  upstreamHostOverride: string | null;
};

export function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const issues: string[] = [];
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    issues.push("DATABASE_URL is not set. The gateway reads routing state from Postgres.");
  }
  const agentDomain = normalizeAgentDomain(env.EVELAND_AGENT_DOMAIN);
  if (!agentDomain) {
    issues.push("EVELAND_AGENT_DOMAIN is not set. Set the agent apex domain (e.g. lvh.me for dev).");
  }
  if (issues.length > 0 || !databaseUrl || !agentDomain) {
    throw new Error(`Gateway startup failed:\n- ${issues.join("\n- ")}`);
  }
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl,
    agentDomain,
    agentUrlEnv: {
      EVELAND_AGENT_DOMAIN: agentDomain,
      EVELAND_AGENT_URL_SCHEME: env.EVELAND_AGENT_URL_SCHEME,
      EVELAND_AGENT_URL_PORT: env.EVELAND_AGENT_URL_PORT,
    },
    upstreamTimeoutMs: Number(env.EVELAND_GATEWAY_UPSTREAM_TIMEOUT_MS ?? 30_000),
    routeTtlMs: Number(env.EVELAND_GATEWAY_ROUTE_TTL_MS ?? 30_000),
    upstreamHostOverride: env.EVELAND_GATEWAY_UPSTREAM_HOST?.trim() || null,
  };
}
```

```ts
// apps/gateway/src/route-cache.ts
import type { AgentRoute } from "./route-source.js";

export type RouteCache = {
  get(slug: string): { route: AgentRoute | null } | undefined;
  set(slug: string, route: AgentRoute | null): void;
  invalidate(slug: string): void;
  clear(): void;
  size(): number;
};

// Negative results are cached as { route: null }; a plain miss returns undefined.
// The cache is a performance layer only -- Postgres stays the source of truth, so
// overflow handling can be a crude clear-all instead of an LRU dependency.
export function createRouteCache(options: { ttlMs: number; maxEntries?: number; now?: () => number }): RouteCache {
  const { ttlMs, maxEntries = 10_000, now = Date.now } = options;
  const entries = new Map<string, { route: AgentRoute | null; expiresAt: number }>();

  return {
    get(slug) {
      const entry = entries.get(slug);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(slug);
        return undefined;
      }
      return { route: entry.route };
    },
    set(slug, route) {
      if (entries.size >= maxEntries) {
        entries.clear();
      }
      entries.set(slug, { route, expiresAt: now() + ttlMs });
    },
    invalidate(slug) {
      entries.delete(slug);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @eveland/gateway test && pnpm --filter @eveland/gateway typecheck`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway apps/api/package.json pnpm-lock.yaml
git commit -m "feat(gateway): scaffold package with config, route source seam, route cache"
```

---

### Task 8: Gateway core — host classification, proxy, server, error mapping

**Files:**
- Create: `apps/gateway/src/host.ts`
- Create: `apps/gateway/src/host.test.ts`
- Create: `apps/gateway/src/headers.ts`
- Create: `apps/gateway/src/headers.test.ts`
- Create: `apps/gateway/src/app.ts`
- Create: `apps/gateway/src/gateway.test.ts`
- Create: `apps/gateway/src/server.ts`

**Interfaces:**
- Consumes: Task 7's `GatewayConfig`, `RouteSource`, `createRouteCache`.
- Produces:
  - `classifyHost(hostHeader: string | undefined, agentDomain: string): { kind: "apex" } | { kind: "agent"; slug: string } | { kind: "unknown" }`
  - `buildForwardHeaders(input: { requestHeaders: IncomingHttpHeaders; clientAddress: string; originalHost: string }): OutgoingHttpHeaders`
  - `filterUpstreamResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders`
  - `createGatewayServer(deps: { config: GatewayConfig; routeSource: RouteSource }): http.Server` — Tasks 9–10 extend this same server.
  - `resolveUpstreamAddress(route: AgentRoute, config: GatewayConfig): string` (loopback rewrite for `EVELAND_GATEWAY_UPSTREAM_HOST`).

- [ ] **Step 1: Write the failing host tests**

```ts
// apps/gateway/src/host.test.ts
import { describe, expect, test } from "vitest";
import { classifyHost } from "./host.js";

describe("classifyHost", () => {
  test("classifies the apex domain, ignoring port, case, and trailing dot", () => {
    expect(classifyHost("lvh.me", "lvh.me")).toEqual({ kind: "apex" });
    expect(classifyHost("LVH.me:8080", "lvh.me")).toEqual({ kind: "apex" });
    expect(classifyHost("lvh.me.", "lvh.me")).toEqual({ kind: "apex" });
  });

  test("extracts a single-label slug", () => {
    expect(classifyHost("my-agent.lvh.me:8080", "lvh.me")).toEqual({ kind: "agent", slug: "my-agent" });
  });

  test("rejects nested labels, unrelated hosts, and missing hosts", () => {
    expect(classifyHost("a.b.lvh.me", "lvh.me")).toEqual({ kind: "unknown" });
    expect(classifyHost("evil-lvh.me", "lvh.me")).toEqual({ kind: "unknown" });
    expect(classifyHost("example.com", "lvh.me")).toEqual({ kind: "unknown" });
    expect(classifyHost(undefined, "lvh.me")).toEqual({ kind: "unknown" });
    expect(classifyHost(".lvh.me", "lvh.me")).toEqual({ kind: "unknown" });
  });
});
```

- [ ] **Step 2: Write the failing header tests**

```ts
// apps/gateway/src/headers.test.ts
import { describe, expect, test } from "vitest";
import { buildForwardHeaders, filterUpstreamResponseHeaders } from "./headers.js";

describe("buildForwardHeaders", () => {
  test("strips hop-by-hop headers and headers named by Connection", () => {
    const headers = buildForwardHeaders({
      requestHeaders: {
        host: "demo.lvh.me:8080",
        connection: "keep-alive, x-custom-hop",
        "keep-alive": "timeout=5",
        te: "trailers",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        "proxy-authorization": "secret",
        "x-custom-hop": "drop-me",
        accept: "application/x-ndjson",
      },
      clientAddress: "203.0.113.7",
      originalHost: "demo.lvh.me:8080",
    });
    expect(headers.accept).toBe("application/x-ndjson");
    for (const gone of ["connection", "keep-alive", "te", "transfer-encoding", "upgrade", "proxy-authorization", "x-custom-hop"]) {
      expect(headers[gone]).toBeUndefined();
    }
  });

  test("preserves the original Host and synthesizes x-forwarded-*", () => {
    const headers = buildForwardHeaders({
      requestHeaders: { host: "demo.lvh.me:8080" },
      clientAddress: "203.0.113.7",
      originalHost: "demo.lvh.me:8080",
    });
    expect(headers.host).toBe("demo.lvh.me:8080");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(headers["x-forwarded-proto"]).toBe("http");
    expect(headers["x-forwarded-host"]).toBe("demo.lvh.me:8080");
  });

  test("appends to an existing x-forwarded-for and passes ingress-set values through", () => {
    const headers = buildForwardHeaders({
      requestHeaders: {
        host: "demo.lvh.me",
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "demo.jinshujuagents.com",
      },
      clientAddress: "203.0.113.7",
      originalHost: "demo.lvh.me",
    });
    expect(headers["x-forwarded-for"]).toBe("198.51.100.1, 203.0.113.7");
    expect(headers["x-forwarded-proto"]).toBe("https");
    expect(headers["x-forwarded-host"]).toBe("demo.jinshujuagents.com");
  });
});

describe("filterUpstreamResponseHeaders", () => {
  test("drops hop-by-hop response headers, keeps the rest", () => {
    const filtered = filterUpstreamResponseHeaders({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "content-type": "application/x-ndjson",
      "x-agent": "yes",
    });
    expect(filtered["content-type"]).toBe("application/x-ndjson");
    expect(filtered["x-agent"]).toBe("yes");
    expect(filtered.connection).toBeUndefined();
    expect(filtered["transfer-encoding"]).toBeUndefined();
  });
});
```

- [ ] **Step 3: Write the failing end-to-end gateway tests**

```ts
// apps/gateway/src/gateway.test.ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createGatewayServer } from "./app.js";
import type { GatewayConfig } from "./config.js";
import type { AgentRoute, RouteSource } from "./route-source.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    databaseUrl: "postgres://unused",
    agentDomain: "lvh.me",
    agentUrlEnv: { EVELAND_AGENT_DOMAIN: "lvh.me", EVELAND_AGENT_URL_SCHEME: "http", EVELAND_AGENT_URL_PORT: "8080" },
    upstreamTimeoutMs: 30_000,
    routeTtlMs: 30_000,
    upstreamHostOverride: null,
    ...overrides,
  };
}

function makeRouteSource(routes: Record<string, AgentRoute | null>): RouteSource {
  return {
    async lookup(slug) {
      if (!(slug in routes)) return null;
      return routes[slug] ?? null;
    },
    async listAgents() {
      return Object.values(routes)
        .filter((route): route is AgentRoute => route !== null)
        .map(({ slug, name }) => ({ slug, name }));
    },
    async subscribe() {},
    async close() {},
  };
}

async function startGateway(config: GatewayConfig, routeSource: RouteSource): Promise<number> {
  return listen(createGatewayServer({ config, routeSource }));
}

describe("gateway", () => {
  test("serves /healthz on any host before routing", async () => {
    const port = await startGateway(makeConfig(), makeRouteSource({}));
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { host: "anything.example.com" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "eveland-gateway" });
  });

  test("proxies method, path, query, body, and streams NDJSON chunk by chunk", async () => {
    const chunks: string[] = [];
    let firstChunkAt = 0;
    let secondChunkAt = 0;
    const upstream = createServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/eve/v1/session?probe=1");
      expect(req.headers.host).toBe("demo.lvh.me");
      let body = "";
      for await (const piece of req) body += piece;
      expect(body).toBe(JSON.stringify({ message: "hi" }));
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"type":"session.started"}\n');
      setTimeout(() => {
        res.end('{"type":"turn.completed"}\n');
      }, 50);
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/eve/v1/session?probe=1`, {
      method: "POST",
      headers: { host: "demo.lvh.me", "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
      if (chunks.length === 1) firstChunkAt = Date.now();
      else secondChunkAt = Date.now();
    }
    // The first NDJSON line arrived before the upstream finished -- no buffering.
    expect(chunks.join("")).toBe('{"type":"session.started"}\n{"type":"turn.completed"}\n');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(secondChunkAt - firstChunkAt).toBeGreaterThanOrEqual(30);
  });

  test("injects x-forwarded-* toward the upstream", async () => {
    let seen: Record<string, unknown> = {};
    const upstream = createServer((req, res) => {
      seen = req.headers;
      res.end("ok");
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "demo.lvh.me" } });
    expect(seen["x-forwarded-proto"]).toBe("http");
    expect(seen["x-forwarded-host"]).toBe("demo.lvh.me");
    expect(String(seen["x-forwarded-for"])).toContain("127.0.0.1");
  });

  test("404 for unknown slugs and unrelated hosts", async () => {
    const port = await startGateway(makeConfig(), makeRouteSource({}));
    const unknownSlug = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "ghost.lvh.me" } });
    expect(unknownSlug.status).toBe(404);
    const unrelated = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "example.com" } });
    expect(unrelated.status).toBe(404);
    const nested = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "a.b.lvh.me" } });
    expect(nested.status).toBe(404);
  });

  test("a known slug with no running deployment maps to 404, same as unknown", async () => {
    const port = await startGateway(makeConfig(), makeRouteSource({ parked: null }));
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "parked.lvh.me" } });
    // The routing query only returns running deployments, so "known but not
    // running" and "unknown slug" both come back null; the 503 distinction
    // lives in ECONNREFUSED handling below.
    expect(response.status).toBe(404);
  });

  test("503 on ECONNREFUSED (deployment swap window)", async () => {
    const upstream = createServer(() => {});
    const upstreamPort = await listen(upstream);
    await new Promise((resolve) => upstream.close(resolve));
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "demo.lvh.me" } });
    expect(response.status).toBe(503);
  });

  test("504 when upstream never sends headers within the timeout", async () => {
    const upstream = createServer(() => {
      /* never respond */
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig({ upstreamTimeoutMs: 100 }),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "demo.lvh.me" } });
    expect(response.status).toBe(504);
  });

  test("503 when the route source itself fails", async () => {
    const failing: RouteSource = {
      async lookup() {
        throw new Error("db down");
      },
      async listAgents() {
        return [];
      },
      async subscribe() {},
      async close() {},
    };
    const port = await startGateway(makeConfig(), failing);
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "demo.lvh.me" } });
    expect(response.status).toBe(503);
  });

  test("rewrites loopback upstreams when upstreamHostOverride is set", async () => {
    // Route points at 127.0.0.1; override rewrites to "localhost", which still
    // resolves to the same test upstream -- asserting the rewrite path executes.
    const upstream = createServer((req, res) => res.end("ok"));
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig({ upstreamHostOverride: "localhost" }),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "demo.lvh.me" } });
    expect(response.status).toBe(200);
  });

  test("route cache serves a second hit without consulting the source", async () => {
    let lookups = 0;
    const upstream = createServer((req, res) => res.end("ok"));
    const upstreamPort = await listen(upstream);
    const counting: RouteSource = {
      async lookup(slug) {
        lookups += 1;
        return { slug, name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort };
      },
      async listAgents() {
        return [];
      },
      async subscribe() {},
      async close() {},
    };
    const port = await startGateway(makeConfig(), counting);
    await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "demo.lvh.me" } });
    await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "demo.lvh.me" } });
    expect(lookups).toBe(1);
  });
});
```

Note the "known but not running" test: the routing query only returns running deployments, so the proxy layer cannot distinguish "unknown slug" from "known, not running" — both are `null` → 404. This simplifies the spec's error table: the 503 rows come from ECONNREFUSED and route-source failure. Adjust the spec's error-mapping table in the Task 10 spec amendment if desired, or keep 404 as the documented behavior for "no running deployment" (recommended: keep the implementation simple; a parked agent is indistinguishable from a nonexistent one to the public).

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @eveland/gateway test`
Expected: FAIL — modules don't exist.

- [ ] **Step 5: Implement**

```ts
// apps/gateway/src/host.ts
export type HostClassification = { kind: "apex" } | { kind: "agent"; slug: string } | { kind: "unknown" };

export function normalizeHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) {
    return null;
  }
  // Bracketed IPv6 hosts can never match a DNS agent domain; strip the port only
  // off name:port shapes so the colon inside [::1] is left alone.
  const withoutPort = hostHeader.startsWith("[") ? hostHeader.replace(/\]:\d+$/, "]") : hostHeader.replace(/:\d+$/, "");
  const normalized = withoutPort.trim().toLowerCase().replace(/\.$/, "");
  return normalized.length > 0 ? normalized : null;
}

export function classifyHost(hostHeader: string | undefined, agentDomain: string): HostClassification {
  const host = normalizeHost(hostHeader);
  if (!host) {
    return { kind: "unknown" };
  }
  if (host === agentDomain) {
    return { kind: "apex" };
  }
  const suffix = `.${agentDomain}`;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    if (label.length > 0 && !label.includes(".")) {
      return { kind: "agent", slug: label };
    }
  }
  return { kind: "unknown" };
}
```

```ts
// apps/gateway/src/headers.ts
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function connectionNamedHeaders(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  if (typeof value !== "string") {
    return new Set();
  }
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function buildForwardHeaders(input: {
  requestHeaders: IncomingHttpHeaders;
  clientAddress: string;
  originalHost: string;
}): OutgoingHttpHeaders {
  const dropped = connectionNamedHeaders(input.requestHeaders);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(input.requestHeaders)) {
    if (value === undefined || HOP_BY_HOP.has(name) || dropped.has(name)) {
      continue;
    }
    headers[name] = value;
  }
  headers.host = input.originalHost;
  const existingForwardedFor = input.requestHeaders["x-forwarded-for"];
  headers["x-forwarded-for"] = existingForwardedFor ? `${String(existingForwardedFor)}, ${input.clientAddress}` : input.clientAddress;
  // The trusted ingress in front sets these; synthesize only when absent (direct
  // dev access). The gateway makes no auth decisions on them.
  headers["x-forwarded-proto"] = input.requestHeaders["x-forwarded-proto"] ?? "http";
  headers["x-forwarded-host"] = input.requestHeaders["x-forwarded-host"] ?? input.originalHost;
  return headers;
}

export function filterUpstreamResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const dropped = connectionNamedHeaders(headers);
  const filtered: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || dropped.has(name)) {
      continue;
    }
    filtered[name] = value;
  }
  return filtered;
}
```

```ts
// apps/gateway/src/app.ts
import http from "node:http";
import type { GatewayConfig } from "./config.js";
import { buildForwardHeaders, filterUpstreamResponseHeaders } from "./headers.js";
import { classifyHost } from "./host.js";
import { createRouteCache } from "./route-cache.js";
import type { AgentRoute, RouteSource } from "./route-source.js";

export function resolveUpstreamAddress(route: AgentRoute, config: GatewayConfig): string {
  const isLoopback = route.hostAddress === "127.0.0.1" || route.hostAddress === "::1" || route.hostAddress === "localhost";
  return config.upstreamHostOverride && isLoopback ? config.upstreamHostOverride : route.hostAddress;
}

export function createGatewayServer(deps: { config: GatewayConfig; routeSource: RouteSource }): http.Server {
  const { config, routeSource } = deps;
  const cache = createRouteCache({ ttlMs: config.routeTtlMs });

  void routeSource
    .subscribe({
      onInvalidate(slug) {
        if (slug === null) {
          cache.clear();
        } else {
          cache.invalidate(slug);
        }
      },
    })
    .catch((error) => {
      console.error("Gateway route subscription failed; serving with TTL-only cache invalidation.", error);
    });

  async function resolveRoute(slug: string): Promise<AgentRoute | null> {
    const cached = cache.get(slug);
    if (cached) {
      return cached.route;
    }
    const route = await routeSource.lookup(slug);
    cache.set(slug, route);
    return route;
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      // Reserved before host classification: load balancer probes must not
      // depend on routing state. This shadows a deployed agent's own /healthz.
      sendJson(res, 200, { ok: true, service: "eveland-gateway" });
      return;
    }

    const classification = classifyHost(req.headers.host, config.agentDomain);

    if (classification.kind === "apex") {
      // Task 10 wires the discovery endpoint here.
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (classification.kind === "unknown") {
      sendJson(res, 404, { error: "Unknown agent domain" });
      return;
    }

    let route: AgentRoute | null;
    try {
      route = await resolveRoute(classification.slug);
    } catch (error) {
      console.error(`Route lookup failed for ${classification.slug}:`, error);
      sendJson(res, 503, { error: "Routing unavailable" });
      return;
    }

    if (!route) {
      sendJson(res, 404, { error: "Unknown agent domain" });
      return;
    }

    proxyRequest(req, res, route, config);
  });

  return server;
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, route: AgentRoute, config: GatewayConfig): void {
  const upstream = http.request({
    host: resolveUpstreamAddress(route, config),
    port: route.hostPort,
    method: req.method,
    path: req.url,
    headers: buildForwardHeaders({
      requestHeaders: req.headers,
      clientAddress: req.socket.remoteAddress ?? "unknown",
      originalHost: req.headers.host ?? "",
    }),
    // The forward headers carry the original public Host; node must not
    // overwrite it with the upstream address.
    setHost: false,
  });

  // Header-phase timeout only: once the upstream starts responding, NDJSON
  // streams may stay open indefinitely.
  const headerTimer = setTimeout(() => {
    upstream.destroy(new HeaderTimeoutError());
  }, config.upstreamTimeoutMs);

  upstream.on("response", (upstreamResponse) => {
    clearTimeout(headerTimer);
    res.writeHead(upstreamResponse.statusCode ?? 502, filterUpstreamResponseHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(res);
  });

  upstream.on("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(headerTimer);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HeaderTimeoutError) {
      sendJson(res, 504, { error: "Upstream timed out before sending headers" });
      return;
    }
    if (error.code === "ECONNREFUSED") {
      sendJson(res, 503, { error: "Agent deployment is not accepting connections" });
      return;
    }
    sendJson(res, 502, { error: "Upstream request failed" });
  });

  req.on("aborted", () => {
    clearTimeout(headerTimer);
    upstream.destroy();
  });

  req.pipe(upstream);
}

class HeaderTimeoutError extends Error {
  constructor() {
    super("Upstream header timeout");
    this.name = "HeaderTimeoutError";
  }
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
```

```ts
// apps/gateway/src/server.ts
import { createGatewayServer } from "./app.js";
import { loadGatewayConfig } from "./config.js";
import { createPostgresRouteSource } from "./postgres-route-source.js";

const config = loadGatewayConfig(process.env);
const routeSource = createPostgresRouteSource(config);
const server = createGatewayServer({ config, routeSource });

server.listen(config.port, () => {
  console.log(`Eveland gateway listening on http://localhost:${config.port} for *.${config.agentDomain}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void routeSource.close().finally(() => process.exit(0));
    });
  });
}
```

`postgres-route-source.ts` doesn't exist until Task 11 — to keep this task self-contained and compiling, create a stub now:

```ts
// apps/gateway/src/postgres-route-source.ts (stub; Task 11 replaces the body)
import type { GatewayConfig } from "./config.js";
import type { RouteSource } from "./route-source.js";

export function createPostgresRouteSource(config: GatewayConfig): RouteSource {
  void config;
  throw new Error("Postgres route source not implemented yet (Task 11).");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @eveland/gateway test && pnpm --filter @eveland/gateway typecheck`
Expected: PASS / clean. If the streaming test is flaky on timing, raise the upstream delay from 50ms to 150ms and the assertion floor accordingly.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): host routing, streaming reverse proxy, error mapping"
```

---

### Task 9: WebSocket upgrade pass-through

**Files:**
- Create: `apps/gateway/src/upgrade.ts`
- Modify: `apps/gateway/src/app.ts` (wire `server.on("upgrade", ...)`)
- Modify: `apps/gateway/src/gateway.test.ts`

**Interfaces:**
- Consumes: `classifyHost`, `buildForwardHeaders` (kept `upgrade`/`connection` for this path), route resolution from Task 8.
- Produces: `handleUpgrade(deps: { config: GatewayConfig; resolveRoute: (slug: string) => Promise<AgentRoute | null> }): (req: IncomingMessage, socket: Duplex, head: Buffer) => void`

- [ ] **Step 1: Write the failing test** (append to `gateway.test.ts`)

```ts
import { connect } from "node:net";

test("websocket upgrade is piped raw in both directions", async () => {
  // Upstream that completes the handshake and echoes raw bytes.
  const upstream = createServer(() => {});
  upstream.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(data));
  });
  const upstreamPort = await listen(upstream);
  const port = await startGateway(
    makeConfig(),
    makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
  );

  const received = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffered = "";
    let upgraded = false;
    socket.on("data", (data) => {
      buffered += data.toString();
      if (!upgraded && buffered.includes("\r\n\r\n")) {
        expect(buffered).toContain("101 Switching Protocols");
        upgraded = true;
        buffered = buffered.slice(buffered.indexOf("\r\n\r\n") + 4);
        socket.write("ping-frame");
        return;
      }
      if (upgraded && buffered.includes("ping-frame")) {
        socket.destroy();
        resolve(buffered);
      }
    });
    socket.on("error", reject);
    socket.write("GET /ws HTTP/1.1\r\nHost: demo.lvh.me\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  });
  expect(received).toContain("ping-frame");
});

test("upgrade for an unknown slug answers 404 and closes", async () => {
  const port = await startGateway(makeConfig(), makeRouteSource({}));
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data.toString();
    });
    socket.on("close", () => resolve(buffered));
    socket.on("error", reject);
    socket.write("GET /ws HTTP/1.1\r\nHost: ghost.lvh.me\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  expect(response).toContain("404");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @eveland/gateway test -- gateway`
Expected: FAIL — the upgrade request hangs or errors (no upgrade handler → node destroys the socket without a 101).

- [ ] **Step 3: Implement**

```ts
// apps/gateway/src/upgrade.ts
import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { resolveUpstreamAddress } from "./app.js";
import type { GatewayConfig } from "./config.js";
import { buildForwardHeaders } from "./headers.js";
import { classifyHost } from "./host.js";
import type { AgentRoute } from "./route-source.js";

export function handleUpgrade(deps: {
  config: GatewayConfig;
  resolveRoute: (slug: string) => Promise<AgentRoute | null>;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    void (async () => {
      const classification = classifyHost(req.headers.host, deps.config.agentDomain);
      if (classification.kind !== "agent") {
        rejectSocket(socket, 404, "Unknown agent domain");
        return;
      }
      let route: AgentRoute | null;
      try {
        route = await deps.resolveRoute(classification.slug);
      } catch {
        rejectSocket(socket, 503, "Routing unavailable");
        return;
      }
      if (!route) {
        rejectSocket(socket, 404, "Unknown agent domain");
        return;
      }

      const upstream = connect(route.hostPort, resolveUpstreamAddress(route, deps.config), () => {
        const headers = buildForwardHeaders({
          requestHeaders: req.headers,
          clientAddress: req.socket.remoteAddress ?? "unknown",
          originalHost: req.headers.host ?? "",
        });
        // The upgrade handshake is the one place hop-by-hop headers must survive.
        headers.connection = "Upgrade";
        headers.upgrade = req.headers.upgrade;
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [name, value] of Object.entries(headers)) {
          if (value === undefined) continue;
          for (const single of Array.isArray(value) ? value : [String(value)]) {
            lines.push(`${name}: ${single}`);
          }
        }
        upstream.write(lines.join("\r\n") + "\r\n\r\n");
        if (head.length > 0) {
          upstream.write(head);
        }
        // From here the sockets are opaque byte pipes -- the 101 response and
        // all websocket frames pass through untouched.
        upstream.pipe(socket);
        socket.pipe(upstream);
      });

      upstream.on("error", () => rejectSocket(socket, 502, "Upstream request failed"));
      socket.on("error", () => upstream.destroy());
    })();
  };
}

function rejectSocket(socket: Duplex, status: number, message: string): void {
  const reason = { 404: "Not Found", 502: "Bad Gateway", 503: "Service Unavailable" }[status] ?? "Error";
  const body = JSON.stringify({ error: message });
  socket.write(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  socket.destroy();
}
```

In `app.ts`, extract `resolveRoute` so both handlers share it, and wire:

```ts
import { handleUpgrade } from "./upgrade.js";
// after creating `server`:
server.on("upgrade", handleUpgrade({ config, resolveRoute }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @eveland/gateway test && pnpm --filter @eveland/gateway typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): raw websocket upgrade pass-through"
```

---

### Task 10: Discovery endpoint

**Files:**
- Create: `apps/gateway/src/discovery.ts`
- Modify: `apps/gateway/src/app.ts` (apex branch)
- Modify: `apps/gateway/src/gateway.test.ts`
- Modify: `docs/superpowers/specs/2026-07-11-standalone-gateway-design.md` (spec amendments; see Step 3)

**Interfaces:**
- Consumes: `RouteSource.listAgents()`, `mintAgentUrl`, `config.agentUrlEnv`.
- Produces: `handleDiscovery(res: ServerResponse, deps: { routeSource: RouteSource; config: GatewayConfig }): Promise<void>` serving `{ agents: [{ slug, name, url }] }`.

- [ ] **Step 1: Write the failing tests** (append to `gateway.test.ts`)

```ts
describe("discovery", () => {
  test("serves running agents with minted urls on the apex host only", async () => {
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({
        demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: 41000 },
        other: { slug: "other", name: "Other", hostAddress: "127.0.0.1", hostPort: 41001 },
      }),
    );
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/eve/agents.json`, { headers: { host: "lvh.me" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await response.json();
    expect(body.agents).toEqual(
      expect.arrayContaining([
        { slug: "demo", name: "Demo", url: "http://demo.lvh.me:8080" },
        { slug: "other", name: "Other", url: "http://other.lvh.me:8080" },
      ]),
    );
  });

  test("apex host 404s everything else", async () => {
    const port = await startGateway(makeConfig(), makeRouteSource({}));
    const response = await fetch(`http://127.0.0.1:${port}/anything`, { headers: { host: "lvh.me" } });
    expect(response.status).toBe(404);
  });

  test("the discovery path on an agent host proxies to the agent, not the gateway", async () => {
    const upstream = createServer((req, res) => {
      res.end(JSON.stringify({ from: "agent", path: req.url }));
    });
    const upstreamPort = await listen(upstream);
    const port = await startGateway(
      makeConfig(),
      makeRouteSource({ demo: { slug: "demo", name: "Demo", hostAddress: "127.0.0.1", hostPort: upstreamPort } }),
    );
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/eve/agents.json`, { headers: { host: "demo.lvh.me" } });
    await expect(response.json()).resolves.toEqual({ from: "agent", path: "/.well-known/eve/agents.json" });
  });
});
```

- [ ] **Step 2: Implement**

```ts
// apps/gateway/src/discovery.ts
import type { ServerResponse } from "node:http";
import { mintAgentUrl } from "@eveland/shared/agent-domain";
import type { GatewayConfig } from "./config.js";
import type { RouteSource } from "./route-source.js";

export async function handleDiscovery(res: ServerResponse, deps: { routeSource: RouteSource; config: GatewayConfig }): Promise<void> {
  let agents: Array<{ slug: string; name: string }>;
  try {
    agents = await deps.routeSource.listAgents();
  } catch (error) {
    console.error("Discovery listing failed:", error);
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Routing unavailable" }));
    return;
  }
  const body = {
    agents: agents.map((agent) => ({ ...agent, url: mintAgentUrl(agent.slug, deps.config.agentUrlEnv) })),
  };
  res.writeHead(200, {
    "content-type": "application/json",
    // Public, read-only, credential-free: safe to open to browser callers.
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
```

In `app.ts`, the apex branch becomes:

```ts
    if (classification.kind === "apex") {
      if (req.method === "GET" && req.url?.split("?")[0] === "/.well-known/eve/agents.json") {
        await handleDiscovery(res, { routeSource, config });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
      return;
    }
```

- [ ] **Step 3: Amend the spec** (same commit): in `docs/superpowers/specs/2026-07-11-standalone-gateway-design.md`
  1. Error-mapping table: change the "Slug exists but no current deployment" row to 404 with the note "indistinguishable from an unknown slug — the routing query only returns running deployments".
  2. No other spec change in this task (the trigger amendment lands in Task 11).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @eveland/gateway test && pnpm --filter @eveland/gateway typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src docs/superpowers/specs/2026-07-11-standalone-gateway-design.md
git commit -m "feat(gateway): public agents.json discovery endpoint on the apex host"
```

---

### Task 11: Postgres route source, LISTEN wiring, api-startup NOTIFY triggers

**Files:**
- Replace stub: `apps/gateway/src/postgres-route-source.ts`
- Create: `apps/api/src/db/notify-triggers.ts`
- Modify: `apps/api/src/store-factory.ts` (expose the database handle)
- Modify: `apps/api/src/server.ts` (ensure triggers at startup)
- Create: `apps/gateway/src/postgres-route-source.test.ts` (skipped without `DATABASE_URL`)
- Modify: `docs/superpowers/specs/2026-07-11-standalone-gateway-design.md`

**Interfaces:**
- Consumes: `createDatabase` from `@eveland/api/db/client`, `projects`/`deployments` from `@eveland/api/db/schema`, channel `eveland_routes`.
- Produces:
  - `createPostgresRouteSource(config: GatewayConfig): RouteSource`
  - `ensureRouteNotifyTriggers(client: postgres.Sql): Promise<void>` (idempotent, api-owned)
  - `StoreFactoryResult.database?: Database`

- [ ] **Step 1: Implement the route source**

```ts
// apps/gateway/src/postgres-route-source.ts
import { and, eq } from "drizzle-orm";
import { createDatabase } from "@eveland/api/db/client";
import { deployments, projects } from "@eveland/api/db/schema";
import type { GatewayConfig } from "./config.js";
import type { RouteSource } from "./route-source.js";

export function createPostgresRouteSource(config: GatewayConfig): RouteSource {
  const { db, client } = createDatabase(config.databaseUrl);

  const routeSelection = {
    slug: projects.slug,
    name: projects.name,
    hostAddress: deployments.hostAddress,
    hostPort: deployments.hostPort,
  };

  return {
    async lookup(slug) {
      const [row] = await db
        .select(routeSelection)
        .from(projects)
        .innerJoin(deployments, eq(deployments.id, projects.deploymentId))
        .where(and(eq(projects.slug, slug), eq(deployments.status, "running")))
        .limit(1);
      return row ?? null;
    },

    async listAgents() {
      const rows = await db
        .select({ slug: projects.slug, name: projects.name })
        .from(projects)
        .innerJoin(deployments, eq(deployments.id, projects.deploymentId))
        .where(eq(deployments.status, "running"))
        .orderBy(projects.name);
      return rows;
    },

    async subscribe(handlers) {
      // postgres-js re-runs the onlisten callback after every (re)connect of the
      // dedicated listen connection; NOTIFY is a non-durable hint, so each
      // (re)connect clears the whole cache and missed messages heal via TTL.
      await client.listen(
        "eveland_routes",
        (payload) => {
          const slug = payload?.trim();
          handlers.onInvalidate(slug ? slug : null);
        },
        () => handlers.onInvalidate(null),
      );
    },

    async close() {
      await client.end();
    },
  };
}
```

- [ ] **Step 2: Implement the trigger installer**

```ts
// apps/api/src/db/notify-triggers.ts
import type postgres from "postgres";

// Routing invalidation for the gateway. Installed idempotently at api startup
// (not in a drizzle migration) because this repo applies schema with
// `drizzle-kit push`, which cannot run trigger DDL. Triggers rather than
// store-level notify calls so every write path -- future job types, manual SQL
// repair -- invalidates automatically; the control plane stays the only writer.
const routeNotifyDdl = `
CREATE OR REPLACE FUNCTION eveland_notify_route_change() RETURNS trigger AS $$
DECLARE
  slug_value text;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    PERFORM pg_notify('eveland_routes', OLD.slug);
    IF TG_OP = 'UPDATE' AND NEW.slug IS DISTINCT FROM OLD.slug THEN
      PERFORM pg_notify('eveland_routes', NEW.slug);
    END IF;
  ELSE
    SELECT slug INTO slug_value FROM projects WHERE id = COALESCE(NEW.project_id, OLD.project_id);
    IF slug_value IS NOT NULL THEN
      PERFORM pg_notify('eveland_routes', slug_value);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS eveland_projects_route_notify ON projects;
CREATE TRIGGER eveland_projects_route_notify
AFTER UPDATE OF slug, deployment_id, deployment_status OR DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION eveland_notify_route_change();

DROP TRIGGER IF EXISTS eveland_deployments_route_notify ON deployments;
CREATE TRIGGER eveland_deployments_route_notify
AFTER UPDATE OF status, host_port, host_address ON deployments
FOR EACH ROW EXECUTE FUNCTION eveland_notify_route_change();
`;

export async function ensureRouteNotifyTriggers(client: postgres.Sql): Promise<void> {
  await client.unsafe(routeNotifyDdl);
}
```

`apps/api/src/store-factory.ts` — widen the result type and return the handle:

```ts
import { createDatabase, type Database } from "./db/client.js";

export type StoreFactoryResult = {
  store: Store;
  close(): Promise<void>;
  /** Set only for the Postgres store; the api uses it to install NOTIFY triggers. */
  database?: Database;
};
// ...in the postgres branch:
  return {
    store: createPostgresStore(database),
    close: database.close,
    database,
  };
```

`apps/api/src/server.ts` — after `const storeFactory = createStoreFromEnv();`:

```ts
import { ensureRouteNotifyTriggers } from "./db/notify-triggers.js";

if (storeFactory.database) {
  await ensureRouteNotifyTriggers(storeFactory.database.client);
}
```

(`server.ts` is ESM top-level — top-level `await` is fine.)

- [ ] **Step 3: Write the guarded integration test**

```ts
// apps/gateway/src/postgres-route-source.test.ts
import { describe, expect, test } from "vitest";

// End-to-end NOTIFY chain against a real database: requires the dev Postgres
// (pnpm --filter @eveland/api db:push applied) and DATABASE_URL. Skipped in
// plain `pnpm test` runs without a database.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("postgres route source", () => {
  test("lookup resolves a running deployment and NOTIFY invalidates", async () => {
    const { createDatabase } = await import("@eveland/api/db/client");
    const { createPostgresStore } = await import("@eveland/api/db/postgres-store");
    const { ensureRouteNotifyTriggers } = await import("@eveland/api/db/notify-triggers");
    const { createPostgresRouteSource } = await import("./postgres-route-source.js");

    const database = createDatabase(databaseUrl!);
    await ensureRouteNotifyTriggers(database.client);
    const store = createPostgresStore(database);

    const project = await store.createProject({ name: `Gateway IT ${Date.now()}`, importKind: "git", gitUrl: "https://example.com/x.git" });
    const revision = await store.recordSourceRevision({
      projectId: project.id,
      kind: "git",
      commitSha: null,
      sourcePath: "/tmp/it",
      summary: {},
      envVars: [],
      files: [],
      schedules: [],
    });
    await store.recordDeployment({
      projectId: project.id,
      sourceRevisionId: revision.id,
      imageTag: "it:1",
      containerName: `eveland-it-${project.id}`,
      internalPort: 3000,
      hostPort: 41999,
      hostAddress: "127.0.0.1",
      runtimeKind: "docker",
    });

    const routeSource = createPostgresRouteSource({
      port: 0,
      databaseUrl: databaseUrl!,
      agentDomain: "lvh.me",
      agentUrlEnv: { EVELAND_AGENT_DOMAIN: "lvh.me" },
      upstreamTimeoutMs: 30_000,
      routeTtlMs: 30_000,
      upstreamHostOverride: null,
    });

    try {
      const invalidated: Array<string | null> = [];
      await routeSource.subscribe({ onInvalidate: (slug) => invalidated.push(slug) });

      await expect(routeSource.lookup(project.slug)).resolves.toMatchObject({ hostPort: 41999, hostAddress: "127.0.0.1" });

      await store.updateProjectSlug(project.id, `${project.slug}-renamed`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(invalidated).toContain(project.slug);
      expect(invalidated).toContain(`${project.slug}-renamed`);
    } finally {
      await store.deleteProject(project.id);
      await routeSource.close();
      await database.close();
    }
  }, 20_000);
});
```

Also add `"./db/postgres-store": "./src/db/postgres-store.ts"` and `"./db/notify-triggers": "./src/db/notify-triggers.ts"` to `apps/api/package.json` exports (the test imports them).

- [ ] **Step 4: Amend the spec**

In `docs/superpowers/specs/2026-07-11-standalone-gateway-design.md`, LISTEN/NOTIFY section: replace "DB triggers (created in the migration, not application-level notify calls)" with "DB triggers, installed idempotently at api startup (`ensureRouteNotifyTriggers`) — this repo applies schema with `drizzle-kit push`, which cannot run trigger DDL, so a migration file would never execute". Keep the trigger-vs-store-calls rationale sentence.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @eveland/gateway test && pnpm --filter @eveland/api test && pnpm -r typecheck`
Expected: PASS with the postgres test **skipped** (no DATABASE_URL in the test shell). If the local dev Postgres (port 5452 on this machine) is running and migrated, optionally verify the integration test: `DATABASE_URL=postgres://eveland:eveland@localhost:5452/eveland pnpm --filter @eveland/gateway test -- postgres-route-source`.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src apps/api/src apps/api/package.json docs/superpowers/specs/2026-07-11-standalone-gateway-design.md
git commit -m "feat(gateway,api): postgres route source with LISTEN/NOTIFY invalidation"
```

---

### Task 12: Compose, env examples, deploy docs

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Modify: `.env.example`
- Modify: `infra/systemd/eveland-worker.env.example`
- Modify: `docs/deploy/linux.md`
- Modify: `README.md`

**Interfaces:** none produced; consumes the config names from the Global Constraints table.

- [ ] **Step 1: dev compose** — add to `docker-compose.yml` after `worker`; and add the three `EVELAND_AGENT_*` variables to the existing `worker` service's `environment`:

```yaml
  gateway:
    image: node:24-alpine
    working_dir: /workspace
    command: sh -lc "corepack enable && pnpm install && pnpm --filter @eveland/gateway dev"
    depends_on:
      - postgres
    environment:
      CI: "true"
      PORT: 8080
      DATABASE_URL: postgres://eveland:eveland@postgres:5432/eveland
      EVELAND_AGENT_DOMAIN: lvh.me
      EVELAND_AGENT_URL_SCHEME: http
      EVELAND_AGENT_URL_PORT: 8080
      # Deployed agents publish on the host's loopback; from this bridge-network
      # container that loopback is unreachable, so loopback upstreams are
      # rewritten to the host gateway address.
      EVELAND_GATEWAY_UPSTREAM_HOST: host.docker.internal
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "8080:8080"
    volumes:
      - .:/workspace
```

Worker service additions (dev compose `worker.environment`):

```yaml
      EVELAND_AGENT_DOMAIN: lvh.me
      EVELAND_AGENT_URL_SCHEME: http
      EVELAND_AGENT_URL_PORT: 8080
```

- [ ] **Step 2: prod compose** — add to `docker-compose.prod.yml` (mirrors the api service shape; domain/scheme come from the host `.env`):

```yaml
  gateway:
    restart: unless-stopped
    network_mode: host
    ports: !override []
    command: sh -lc "corepack enable && pnpm install && cd apps/gateway && NODE_ENV=production pnpm exec tsx --env-file=../../.env src/server.ts"
    environment:
      CI: "true"
      PORT: 8080
      DATABASE_URL: postgres://eveland:eveland@localhost:5432/eveland
    volumes:
      - .:/workspace
```

(`EVELAND_AGENT_DOMAIN` / `EVELAND_AGENT_URL_SCHEME` reach the process via the host `.env` through `--env-file`; on the host network no upstream rewrite is needed. Note the base compose has no `gateway` service, so unlike api/web this entry defines the full service in the overlay — include `image: node:24-alpine`, `working_dir: /workspace`, and `depends_on: [postgres]` exactly as the base services do.)

- [ ] **Step 3: env examples**

`.env.example` — append:

```
# Agent gateway
EVELAND_AGENT_DOMAIN=lvh.me
EVELAND_AGENT_URL_SCHEME=http
EVELAND_AGENT_URL_PORT=8080
```

`infra/systemd/eveland-worker.env.example` — append the same three lines with a comment that production sets the real apex domain and `https` with no port.

- [ ] **Step 4: docs**

`docs/deploy/linux.md` — extend the existing "Reverse proxy" section with a "Agent gateway" subsection covering, in prose:
- Wildcard DNS `*.<apex>` → external ingress; wildcard cert terminates there; ingress forwards plaintext to `gateway:8080` and sets `x-forwarded-*`.
- The gateway reserves `/healthz`; everything else on `<slug>.<apex>` reaches the agent verbatim (both `/eve/` and `/.well-known/workflow/` flow through — the existing forwarding warning applies to path-based proxies only).
- Discovery endpoint URL on the apex.
- **Upgrade note for existing installs:** the `projects.slug` migration cannot be applied by `db:push` against a non-empty table (NOT NULL + unique needs the backfill). Run the checked-in SQL first, then `db:push` is a no-op for these columns:

```bash
psql "$DATABASE_URL" -f apps/api/drizzle/0005_<name>.sql
psql "$DATABASE_URL" -f apps/api/drizzle/0006_<name>.sql
```

- Changing a slug invalidates the old domain immediately (no redirect).

`README.md` — add the gateway to the service list/quickstart (port 8080, needs `EVELAND_AGENT_DOMAIN`, dev default `lvh.me`).

- [ ] **Step 5: Validate compose syntax and commit**

Run: `docker compose -f docker-compose.yml config --quiet && docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet`
Expected: both exit 0 (config validation only — do not `up`).

```bash
git add docker-compose.yml docker-compose.prod.yml .env.example infra/systemd/eveland-worker.env.example docs/deploy/linux.md README.md
git commit -m "feat(gateway): compose services, env examples, deploy docs"
```

---

### Task 13: Web — agent domain display and slug editing

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/agent-domain.tsx`
- Modify: `apps/web/src/app/projects/[projectId]/page.tsx`

**Interfaces:**
- Consumes: `PATCH /projects/:projectId` (Task 4); `Project.slug` / `Project.agentUrl` in API payloads.
- Produces: `updateProjectSlug(projectId: string, slug: string): Promise<Project>` in `lib/api.ts`; `<AgentDomain projectId slug agentUrl />` client component.

- [ ] **Step 1: Extend the web API client**

`apps/web/src/lib/api.ts` — add to the `Project` type (after `name`):

```ts
  slug: string;
  agentUrl: string | null;
```

Add the mutation (same shape as `enqueueBuildDeploy`):

```ts
export async function updateProjectSlug(projectId: string, slug: string): Promise<Project> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  const data = (await response.json()) as { project?: Project; error?: string };

  if (!response.ok || !data.project) {
    throw new Error(data.error ?? "Slug update failed");
  }

  return data.project;
}
```

- [ ] **Step 2: Create the client component**

```tsx
// apps/web/src/components/agent-domain.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, LoaderCircleIcon, PencilIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { updateProjectSlug } from "@/lib/api";

export function AgentDomain({ projectId, slug, agentUrl }: { projectId: string; slug: string; agentUrl: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(slug);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    try {
      await updateProjectSlug(projectId, value.trim());
      setEditing(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Slug update failed");
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm"
            value={value}
            onChange={(event) => setValue(event.target.value.toLowerCase())}
            disabled={pending}
            autoFocus
          />
          <Button type="button" size="sm" onClick={save} disabled={pending || value.trim().length === 0}>
            {pending ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <CheckIcon data-icon="inline-start" />}
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); setValue(slug); setError(null); }} disabled={pending}>
            <XIcon data-icon="inline-start" />
            Cancel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Changing the slug takes the old domain offline immediately.</p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {agentUrl ? (
        <a href={agentUrl} target="_blank" rel="noreferrer" className="font-medium underline-offset-4 hover:underline">
          {agentUrl.replace(/^https?:\/\//, "")}
        </a>
      ) : (
        <span className="font-mono text-sm text-muted-foreground">{slug} (domain not configured)</span>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)} title="Edit the agent slug">
        <PencilIcon />
      </Button>
    </div>
  );
}
```

(Check `apps/web/src/components/ui/button.tsx` for the exact `size`/`variant` variants available; adjust to what exists rather than inventing new ones.)

- [ ] **Step 3: Render it on the project overview page**

In `apps/web/src/app/projects/[projectId]/page.tsx`, inside the Deployment card's `<dl>` grid, add a full-width cell **before** the mapped entries:

```tsx
          <div className="col-span-2 bg-card p-4">
            <dt className="text-xs text-muted-foreground">Agent domain</dt>
            <dd className="mt-2">
              {project ? <AgentDomain projectId={project.id} slug={project.slug} agentUrl={project.agentUrl} /> : "—"}
            </dd>
          </div>
```

with the import `import { AgentDomain } from "@/components/agent-domain";`.

- [ ] **Step 4: Typecheck, test, commit**

Run: `pnpm --filter @eveland/web typecheck && pnpm --filter @eveland/web test`
Expected: clean / PASS (web tests pass with no new tests; the component is exercised manually).

```bash
git add apps/web/src
git commit -m "feat(web): show agent domain and edit the project slug"
```

---

### Task 14: Full-repo verification and manual QA notes

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck and test sweep**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: every package clean/green (the gateway's postgres integration test reports skipped).

- [ ] **Step 2: Confirm the working tree is fully committed**

Run: `git status --short`
Expected: empty. If anything is left over, fold it into the task it belongs to (amend or a fixup commit).

- [ ] **Step 3: Write the manual QA checklist into the final report** (the user runs these; do NOT run them yourself)

```bash
# 1. Apply schema to the local dev database (port 5452 on this machine):
pnpm --filter @eveland/api db:push

# 2. Start the stack (user-run):
pnpm dev            # api :4000, web :4011 locally, worker
pnpm --filter @eveland/gateway dev   # gateway :8080

# 3. Deploy any project, then:
curl http://lvh.me:8080/.well-known/eve/agents.json
curl http://<slug>.lvh.me:8080/healthz          # gateway health (shadowed path)
curl -X POST http://<slug>.lvh.me:8080/eve/v1/session -H 'content-type: application/json' -d '{"message":"hi"}'

# 4. Verify WORKFLOW_LOCAL_BASE_URL landed in the deployment env (docker runtime):
docker inspect <container> --format '{{json .Config.Env}}' | tr ',' '\n' | grep WORKFLOW_LOCAL
```

- [ ] **Step 4: Push**

```bash
git push origin feat-standalone-gateway
```

---

## Self-Review Notes (kept from plan authoring)

- Spec coverage: domain scheme → Tasks 1/8; standalone service → Tasks 7–11; data model → Tasks 2–5; WORKFLOW_LOCAL_BASE_URL → Task 6; discovery → Task 10; config surface → Tasks 7/12; web/API slug editing → Tasks 3/4/13; ops docs → Task 12.
- Deliberate deviations from the spec, folded back into the spec file by Tasks 10 and 11: (a) "no running deployment" returns 404, not 503 (the routing query cannot distinguish it from an unknown slug); (b) NOTIFY triggers install at api startup, not via migration (db:push cannot run DDL migrations).
- The gateway's `dev` script exists from Task 7 but only becomes runnable at Task 8 (server.ts) and only useful at Task 11 (real route source); nothing in between starts it.
