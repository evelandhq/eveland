# ai-elements

Vendored from eve's generated Web Chat registry:
`vercel/eve` → `apps/docs/registry/channel/web/components/ai-elements/`.

Last synced at commit `fccbf2bbc3551b9a43aa3157be79662827fc884a`
("coerce tool output to string before trimEnd", eve 0.47 era). The one
registry change between the 0.45 and 0.47 sync points needed no port: our
`tool.tsx` already narrows stdout/stderr with `typeof === "string"` guards, so
the upstream `String(...)` coercion has nothing left to fix here. When an eve
upgrade lands, diff the registry against that SHA and port the changes here —
keep structural drift minimal so upstream refinements stay mechanically
portable.
`agent-message.tsx` (one directory up) is ported from the same registry's
`app/_components/agent-message.tsx`.

Known local adaptations to preserve when syncing:

- **Base UI, not Radix.** Our `ui/*` primitives come from `@base-ui/react`:
  `asChild` becomes `render={...}`, `group-data-[state=open]` becomes
  `group-data-[panel-open]`, and collapsible animations key off
  `data-[starting-style]` / `data-[ending-style]` instead of
  `data-[state=open]` / `data-[state=closed]`.
- **Event handler types.** Base UI handlers take `BaseUIEvent`, so callbacks
  are typed via `NonNullable<ComponentProps<typeof X>["onY"]>` rather than raw
  React event types.
- **`reasoning.tsx`** adds a 1s auto-close delay upstream does not have.
- Upstream files not vendored (`chain-of-thought.tsx`) are ones nothing here
  consumes yet.
