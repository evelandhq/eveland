# ai-elements

Vendored from eve's generated Web Chat registry:
`vercel/eve` → `apps/docs/registry/channel/web/components/ai-elements/`.

Last synced against `eve@1.0.0` (commit
`bde24520fa7e23db2eceaf0ead562672b419ba34`). When an eve upgrade lands, diff
the registry against that SHA and port the changes here — keep structural
drift minimal so upstream refinements stay mechanically portable.

| File                                                              | Relation to the registry                                                                                                                                                                                                                                                     |
| :---------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-block.tsx`                                                  | Synced.                                                                                                                                                                                                                                                                      |
| `conversation.tsx`                                                | Synced.                                                                                                                                                                                                                                                                      |
| `message.tsx`                                                     | Synced, with the user bubble on `bg-muted` rather than `bg-primary` (so the registry's link-colour override for the primary bubble does not apply).                                                                                                                          |
| `tool.tsx`                                                        | `BashToolContent`, `ToolInput`, and `ToolOutput` are synced (stdout/stderr narrowed with `typeof` guards where the registry coerces with `String(...)`). `Tool`, `ToolHeader`, and `ToolContent` are local: the registry moved its tool rows into `components/ui/trace.tsx`. |
| `prompt-input.tsx`                                                | Local superset: the registry trimmed its composer to the basics, while the Playground composer keeps attachments and the fuller input.                                                                                                                                       |
| `attachments.tsx`, `question.tsx`, `reasoning.tsx`, `shimmer.tsx` | Local. The registry no longer ships them: questions moved to `components/ui/questionnaire.tsx` and reasoning to `components/ui/trace.tsx`.                                                                                                                                   |

`agent-message.tsx` (one directory up) is ported from the same registry's
`app/_components/agent-message.tsx` and follows its semantics (task control
calls are not shown, a call shows every question it asked), rendered with the
local tool, question, and reasoning components above rather than the
registry's trace and questionnaire components.

Known local adaptations to preserve when syncing:

- **Base UI, not Radix.** Our `ui/*` primitives come from `@base-ui/react`:
  `asChild` becomes `render={...}`, `group-data-[state=open]` becomes
  `group-data-[panel-open]`, and collapsible animations key off
  `data-[starting-style]` / `data-[ending-style]` instead of
  `data-[state=open]` / `data-[state=closed]`.
- **Event handler types.** Base UI handlers take `BaseUIEvent`, so callbacks
  are typed via `NonNullable<ComponentProps<typeof X>["onY"]>` rather than raw
  React event types.
- **`reasoning.tsx`** closes itself one second after reasoning ends.
