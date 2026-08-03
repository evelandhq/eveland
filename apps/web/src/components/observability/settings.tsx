"use client";

import { useState } from "react";
import type { AgentCapturePolicy, PublicObservabilityPolicy } from "@eveland/core/observability";
import {
  createObservabilityDestination,
  deleteObservabilityDestination,
  saveObservabilitySettings,
  toggleObservabilityDestination,
  updateObservabilityDestination,
} from "@/lib/client-api";
import { ObservabilityCaptureForm } from "./capture-form";
import { ObservabilityDestinationDialog } from "./destination-dialog";
import {
  destinationPatch,
  draftFromDestination,
  emptyDestinationDraft,
  type DestinationEditor,
  type ObservabilityDestination,
} from "./destination-draft";
import { ObservabilityDestinationList } from "./destination-list";

export function ObservabilitySettings({
  initialSettings,
}: {
  initialSettings: PublicObservabilityPolicy;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [capture, setCapture] = useState(initialSettings.agentCapture);
  const [pending, setPending] = useState(false);
  const [editor, setEditor] = useState<DestinationEditor | null>(null);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateCapture(patch: Partial<AgentCapturePolicy>) {
    setCapture((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await saveObservabilitySettings({
        expectedRevision: settings.revision,
        agentCapture: capture,
      });
      setSettings(updated);
      setCapture(updated.agentCapture);
      setSaved(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update the observability policy.",
      );
    } finally {
      setPending(false);
    }
  }

  function openCreateDialog() {
    setDestinationError(null);
    setEditor({
      destinationId: null,
      draft: emptyDestinationDraft(),
      storedCredentials: null,
    });
  }

  function openEditDialog(destination: ObservabilityDestination) {
    setDestinationError(null);
    setEditor({
      destinationId: destination.id,
      draft: draftFromDestination(destination),
      storedCredentials: destination.config
        ? {
            headerNames:
              destination.config.kind === "custom_otlp" ? destination.config.headerNames : [],
          }
        : null,
    });
  }

  async function submitDestination(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    setPending(true);
    setDestinationError(null);
    try {
      const config = destinationPatch(editor.draft);
      setSettings(
        editor.destinationId === null
          ? await createObservabilityDestination({
              expectedRevision: settings.revision,
              config,
            })
          : await updateObservabilityDestination({
              destinationId: editor.destinationId,
              expectedRevision: settings.revision,
              config,
            }),
      );
      setEditor(null);
    } catch (caught) {
      setDestinationError(
        caught instanceof Error ? caught.message : "Could not configure the destination.",
      );
    } finally {
      setPending(false);
    }
  }

  async function toggleDestination(destinationId: string, enabled: boolean) {
    setPending(true);
    setError(null);
    try {
      setSettings(
        await toggleObservabilityDestination({
          destinationId,
          expectedRevision: settings.revision,
          enabled,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the destination.");
    } finally {
      setPending(false);
    }
  }

  async function deleteDestination(destinationId: string) {
    setPending(true);
    setError(null);
    try {
      setSettings(
        await deleteObservabilityDestination({
          destinationId,
          expectedRevision: settings.revision,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the destination.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <ObservabilityDestinationList
        destinations={settings.externalDestinations}
        pending={pending}
        error={error}
        onCreate={openCreateDialog}
        onEdit={openEditDialog}
        onToggle={(destinationId, enabled) => void toggleDestination(destinationId, enabled)}
        onDelete={(destinationId) => void deleteDestination(destinationId)}
      />
      <ObservabilityCaptureForm
        capture={capture}
        pending={pending}
        saved={saved}
        onChange={updateCapture}
        onSubmit={save}
      />
      {editor ? (
        <ObservabilityDestinationDialog
          editor={editor}
          pending={pending}
          error={destinationError}
          onOpenChange={(open) => {
            if (!pending && !open) setEditor(null);
          }}
          onDraftChange={(patch) =>
            setEditor((current) =>
              current ? { ...current, draft: { ...current.draft, ...patch } } : current,
            )
          }
          onSubmit={submitDestination}
        />
      ) : null}
    </div>
  );
}
