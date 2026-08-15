import { runExtensionIntegration } from "./extension-integration-runtime.js";

const result = await runExtensionIntegration(process.cwd());
process.stdout.write(`[eveland-extensions] ${JSON.stringify(result)}\n`);
