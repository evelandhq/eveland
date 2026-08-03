"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SaveIcon } from "lucide-react";
import type { Project } from "@/lib/api";
import { updateProjectMetadata } from "@/lib/client-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export function ProjectGeneralSettings({ project }: { project: Project }) {
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await updateProjectMetadata(project.id, {
        name,
        description,
      });
      setName(updated.name);
      setDescription(updated.description ?? "");
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update project details.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="flex max-w-3xl flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="project-display-name">Display name</FieldLabel>
          <Input
            id="project-display-name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            minLength={1}
            maxLength={80}
            required
          />
          <FieldDescription>
            A human-readable name. Changing it does not alter the public Agent address.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="project-description">Description</FieldLabel>
          <Textarea
            id="project-description"
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            maxLength={240}
            rows={3}
            placeholder="Describe what this Agent can do."
          />
          <FieldDescription>
            Describe the Agent&apos;s routine capabilities for people and future catalog discovery.{" "}
            {description.length}/240
          </FieldDescription>
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field data-disabled>
            <FieldLabel htmlFor="project-slug">Project slug</FieldLabel>
            <Input id="project-slug" value={project.slug} readOnly />
            <FieldDescription>Stable public identifier. It cannot be changed.</FieldDescription>
          </Field>
          <Field data-disabled>
            <FieldLabel htmlFor="project-id">Project ID</FieldLabel>
            <Input id="project-id" value={project.id} readOnly />
            <FieldDescription>Internal Eveland identifier. It cannot be changed.</FieldDescription>
          </Field>
        </div>
        <Field data-disabled>
          <FieldLabel htmlFor="project-source">Source repository</FieldLabel>
          <Input id="project-source" value={project.gitUrl ?? "Uploaded Zip"} readOnly />
        </Field>
      </FieldGroup>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {saved ? (
        <Alert>
          <AlertDescription>Project details saved.</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="submit" disabled={pending || name.trim().length === 0}>
          {pending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
