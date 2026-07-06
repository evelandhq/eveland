"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranchIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function NewProjectForms() {
  return (
    <section className="mx-auto grid w-full max-w-4xl gap-6 px-6 py-8 md:grid-cols-[1fr_1fr]">
      <GitProjectForm />
      <ZipProjectForm />
    </section>
  );
}

function GitProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const response = await fetch(`${apiBaseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, importKind: "git", gitUrl }),
    });

    setPending(false);

    if (!response.ok) {
      setError(await readError(response, "Import request failed."));
      return;
    }

    const body = (await response.json()) as { project: { id: string } };
    router.push(`/projects/${body.project.id}`);
  }

  return (
    <form className="flex flex-col gap-4 rounded-md border border-border bg-card p-5" onSubmit={submit}>
      <div className="flex items-center gap-2">
        <GitBranchIcon data-icon="inline-start" />
        <h2 className="text-sm font-semibold">Git repo</h2>
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Project name
        <input value={name} onChange={(event) => setName(event.target.value)} className="h-8 rounded-sm border border-input bg-background px-2 text-sm" placeholder="Weather agent" />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Git URL
        <input value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} className="h-8 rounded-sm border border-input bg-background px-2 text-sm" placeholder="https://github.com/acme/weather-agent.git" />
      </label>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Importing..." : "Import Git repo"}
      </Button>
      <p className="text-xs text-muted-foreground">The API queues source import immediately; worker processing can be attached to the same job row.</p>
    </form>
  );
}

function ZipProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!archive) {
      setError("Choose a zip archive.");
      return;
    }

    setPending(true);
    setError(null);
    const form = new FormData();
    form.set("name", name);
    form.set("archive", archive);

    const response = await fetch(`${apiBaseUrl}/projects`, {
      method: "POST",
      body: form,
    });

    setPending(false);

    if (!response.ok) {
      setError(await readError(response, "Zip upload failed."));
      return;
    }

    const body = (await response.json()) as { project: { id: string } };
    router.push(`/projects/${body.project.id}`);
  }

  return (
    <form className="flex flex-col gap-4 rounded-md border border-border bg-card p-5" onSubmit={submit}>
      <div className="flex items-center gap-2">
        <UploadIcon data-icon="inline-start" />
        <h2 className="text-sm font-semibold">Zip upload</h2>
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Project name
        <input required value={name} onChange={(event) => setName(event.target.value)} className="h-8 rounded-sm border border-input bg-background px-2 text-sm" placeholder="Support analyst" />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Source archive
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
          className="h-8 rounded-sm border border-input bg-background px-2 py-1 text-xs"
        />
      </label>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Uploading..." : "Upload Zip project"}
      </Button>
    </form>
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string; issues?: Array<{ message?: string }> };
    return body.detail ?? body.issues?.[0]?.message ?? body.error ?? fallback;
  } catch {
    return fallback;
  }
}
