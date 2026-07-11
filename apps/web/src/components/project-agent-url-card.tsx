"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAgentUrlDisplay } from "@/lib/agent-url";
import { getProject, updateProjectSlug, type Project } from "@/lib/api";

const FAILED_TO_UPDATE_SLUG = "Failed to update slug";

export function ProjectAgentUrlCard({ initialProject, projectId }: { initialProject: Project | null; projectId: string }) {
  const [project, setProject] = useState<Project | null>(initialProject);
  const [slugDraft, setSlugDraft] = useState(initialProject?.slug ?? "");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [slugBusy, setSlugBusy] = useState(false);
  const loadVersion = useRef(0);
  const agentUrlDisplay = getAgentUrlDisplay(project);

  const loadProject = useCallback(async () => {
    const version = loadVersion.current + 1;
    loadVersion.current = version;

    try {
      const loadedProject = await getProject(projectId);
      if (loadVersion.current !== version) {
        return;
      }

      setProject(loadedProject);
      setSlugDraft(loadedProject?.slug ?? "");
    } catch {
      return;
    }
  }, [projectId]);

  useEffect(() => {
    setProject(initialProject);
    setSlugDraft(initialProject?.slug ?? "");
    setSlugError(null);
  }, [initialProject]);

  async function saveSlug() {
    if (!project || slugBusy) {
      return;
    }

    setSlugBusy(true);
    setSlugError(null);

    try {
      const updatedProject = await updateProjectSlug(projectId, slugDraft);
      setProject(updatedProject);
      setSlugDraft(updatedProject.slug);
      await loadProject();
    } catch (error) {
      setSlugError(error instanceof Error ? error.message : FAILED_TO_UPDATE_SLUG);
    } finally {
      setSlugBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Agent URL</h2>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Agent slug"
            value={slugDraft}
            onChange={(event) => setSlugDraft(event.target.value)}
            disabled={slugBusy}
            placeholder="agent-slug"
            className="h-8 min-w-0 flex-1 rounded-sm border border-input bg-background px-2 text-sm outline-none transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <span className="text-sm text-muted-foreground">{agentUrlDisplay.hostLabel}</span>
          <Button type="button" onClick={saveSlug} disabled={slugBusy || !project}>
            {slugBusy ? "Saving..." : "Save"}
          </Button>
          {agentUrlDisplay.configured && !slugBusy ? (
            <Button render={<a href={agentUrlDisplay.href} target="_blank" rel="noreferrer" />} variant="outline">
              <ExternalLink data-icon="inline-start" />
              Open Agent
            </Button>
          ) : agentUrlDisplay.configured ? (
            <Button type="button" variant="outline" disabled>
              <ExternalLink data-icon="inline-start" />
              Open Agent
            </Button>
          ) : null}
        </div>
        {slugError ? <p className="text-xs text-destructive">{slugError}</p> : null}
        <p className="break-all text-xs text-muted-foreground">{agentUrlDisplay.fullLabel}</p>
      </div>
    </div>
  );
}
