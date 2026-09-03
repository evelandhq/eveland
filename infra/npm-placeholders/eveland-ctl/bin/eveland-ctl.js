#!/usr/bin/env node
// Defensive name registration. The real eveland-ctl is bound to a local
// Eveland installation and ships only with the source tree, so there is
// nothing meaningful an npm copy of it could do.
console.error(
  [
    "eveland-ctl is not distributed through npm.",
    "",
    "It operates a local Eveland installation, so it ships with the",
    "installed source tree rather than as a standalone package.",
    "",
    "  Install Eveland:  curl -fsSL https://eveland.ai/install.sh | sh",
    "  Docs:             https://eveland.ai/docs",
    "",
    "This npm package exists only to hold the name.",
  ].join("\n"),
);
process.exit(1);
