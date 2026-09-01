import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";
import { evelandMemoryBackend } from "eveland/memory";

// Per-user memory that survives sessions and redeploys. The explicit backend
// matters: bare fileMemory() only auto-resolves under `eve dev`; on an
// eveland deployment it must be told where to write. evelandMemoryBackend()
// reads the platform-injected EVELAND_MEMORY_ROOT and steps aside (returns
// undefined) anywhere else, so this file works unchanged under `eve dev` too.
export default defineMemory({
  scope: byPrincipal,
  provider: fileMemory({ backend: evelandMemoryBackend() }),
});
