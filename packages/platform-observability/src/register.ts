import { register as registerAsyncHook } from "node:module";
import {
  register as registerSyncHooks,
  supportsSyncHooks,
} from "import-in-the-middle/register-hooks.mjs";

if (supportsSyncHooks()) {
  registerSyncHooks();
} else {
  registerAsyncHook(
    "@opentelemetry/instrumentation/hook.mjs",
    import.meta.url,
  );
}
