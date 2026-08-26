# ai-elements

Vendored from eve's generated Web Chat registry:
`vercel/eve` → `apps/docs/registry/channel/web/components/ai-elements/`.

Last synced at commit `659774fdf841e419498552c8a3565d40f5298e0f`
("Refine generated Web Chat interactions", eve 0.45 era). When an eve upgrade
lands, diff the registry against that SHA and port the changes here — keep
structural drift minimal so upstream refinements stay mechanically portable.
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
