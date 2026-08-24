---
title: Deploy your first agent
description: Import an existing Eve project, build a preview, and promote it to a stable route.
---

This guide starts after a platform administrator has completed [production verification](/docs/production/verify). Eveland deploys ordinary Eve projects without changing their authored source.

## 1. Check compatibility

The project must declare an Eve dependency inside Eveland's verified compatibility window. Eveland validates the real project structure and fails closed when the version is missing, outside the window, or cannot be proven compatible. See the [Eve compatibility window](/docs/reference/eve-compatibility) for supported versions and runtime constraints.

## 2. Import source

Create a Project from an HTTPS Git URL or a Zip archive. Source Preflight validates the snapshot before the Project and first import job are committed. Git projects can sync later; Zip imports remain fixed snapshots. See [Source import](/docs/reference/source-import) for validation rules and file layout requirements.

## 3. Configure runtime values

Add the provider keys and application values the Agent needs. Values are encrypted, never displayed again, and do not enter imported source, releases, logs, or session events. See [Secrets and Connections](/docs/agents/secrets-connections) and [Agent environment](/docs/reference/agent-environment) for precedence and variable scopes.

## 4. Build the preview

Build & Deploy prepares a separate Release, installs the project's locked dependency graph, injects the private telemetry hook and sandbox integration, starts an isolated Deployment, and waits for health. It never stops or reuses the current stable target as part of a successful deploy.

## 5. Test and promote

Call the immutable preview hostname or use [Playground](/docs/reference/playground). Check responses, streaming, tool and subagent activity, runtime diagnostics, and usage. Promote only the healthy Deployment; promotion atomically updates the stable route without rebuilding the Release.

Continue with [Releases and traffic](/docs/agents/releases-routing) before configuring rollback or weighted routing.

## Deeper reference

- [Playground behavior and authentication contract](/docs/reference/playground)
- [Source import rules and preflight](/docs/reference/source-import)
- [Releases, weighted routing, and session affinity](/docs/agents/releases-routing)
