import { installEvelandModelGatewayProvider } from "./provider.js";

installEvelandModelGatewayProvider();

/**
 * A plain Eve hook configuration, deliberately NOT wrapped in `defineHook`:
 * this module is bundled fully self-contained and baked into every release
 * (`.eveland/model-gateway/runtime.mjs`), where the Agent's `eve/hooks` is
 * not resolvable. The shim written next to the Agent's own hooks imports
 * `defineHook` from the Agent's Eve installation and wraps this default
 * export. The hook itself observes nothing — the module's import side effect
 * (installing the AI SDK default provider before any turn resolves a string
 * model) is the entire payload.
 */
export default {
  events: {},
};
