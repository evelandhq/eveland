---
title: Deploy your first agent
description: Import an existing Eve project, build a preview environment, and promote it to production.
---

Before following this guide, ensure your platform administrator has completed [production verification](/docs/production/verify). Eveland natively deploys standard Eve projects without requiring proprietary modifications to your codebase.

## 1. Verify framework compatibility

Eveland requires your project to declare an Eve dependency within its verified compatibility window. The platform automatically validates the dependency tree during deployment. For details on supported versions, see the [Eve compatibility window](/docs/reference/eve-compatibility).

## 2. Import project source

Create a new Project in the web dashboard using either of two methods:

- **Git repository**: Provide an HTTPS repository URL. You can easily sync new commits later.
- **Zip archive**: Upload an archive file as a fixed, immutable snapshot.

During import, Eveland runs preflight checks to validate directory structure and dependency manifests. For layout requirements, see [Source import](/docs/reference/source-import).

## 3. Configure runtime secrets and variables

In your Project settings, add required model provider keys (e.g. `OPENAI_API_KEY`) and application configuration:

- **Encrypted at rest**: All sensitive values are securely encrypted and never leak into logs, releases, or telemetry traces.
- **Shared defaults**: Platform-wide defaults configured by administrators in the Shared Agent Environment apply automatically, and can be overridden per project.

For precedence rules, see [Secrets and Connections](/docs/agents/secrets-connections).

## 4. Build and preview deployment

Click **Build & Deploy** to start the automated build pipeline:

1. Eveland creates a distinct immutable Release;
2. Installs locked dependencies and builds your agent inside an isolated sandbox;
3. Starts a preview Deployment and validates its HTTP health check.

This process runs completely in isolation and **never disrupts or reuses existing production traffic**.

## 5. Test and promote

Once deployed, verify your agent before going live:

- **Immutable preview URL**: Each deployment receives a dedicated hostname (e.g. `dep_xxx--project.agents.example.com`) for direct API or web testing.
- **Interactive Playground**: Open the built-in [Playground](/docs/reference/playground) to test prompts, tool calls, and streaming responses interactively.

When satisfied, click **Promote**. Eveland atomically updates the stable route at the gateway level without needing to rebuild the release.

To learn about canary releases (weighted routing) and instant rollbacks, proceed to [Releases and traffic routing](/docs/agents/releases-routing).

## Related references

- [Interactive Playground guide](/docs/reference/playground)
- [Source import rules and structure](/docs/reference/source-import)
- [Release management and weighted routing](/docs/agents/releases-routing)
