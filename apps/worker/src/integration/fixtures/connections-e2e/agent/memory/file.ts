import { defaultNamespace, defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";
import { evelandMemoryBackend, evelandMemoryNamespace } from "eveland/memory";

// Durable memory on the platform's memory directory, one document per user,
// set up as the agent environment reference documents. The smoke saves a fact,
// then recalls it after a restart and from a second Release.
export default defineMemory({
  description: "Remember stable facts the caller asks to keep.",
  scope: byPrincipal,
  namespace: evelandMemoryNamespace(defaultNamespace),
  provider: fileMemory({ backend: evelandMemoryBackend() }),
});
