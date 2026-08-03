#!/usr/bin/env node

import("../dist/cli.js")
  .then((module) => module.setupDatabase())
  .catch((error) => {
    console.error("Failed to set up the Eveland workflow world:", error);
    process.exit(1);
  });
