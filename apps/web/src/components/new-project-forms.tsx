"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircleIcon, GitBranchIcon, UploadIcon } from "lucide-react";
import {
  inferProjectSlugFromGitUrl,
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_PATTERN,
  slugifyProjectName,
} from "@eveland/core/ids";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const invalidNameMessage = "Use lowercase letters, numbers, and hyphens, with no leading or trailing hyphen.";

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
  const [nameEdited, setNameEdited] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inferredName = inferProjectSlugFromGitUrl(gitUrl);
  const repositoryInvalid = gitUrl.length > 0 && inferredName === null;
  const nameInvalid =
    name.length > 0 && (name.length > PROJECT_SLUG_MAX_LENGTH || !PROJECT_SLUG_PATTERN.test(name));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (repositoryInvalid || nameInvalid || !name) return;
    setPending(true);
    setError(null);

    const response = await fetch(`${apiBaseUrl}/projects`, {
      method: "POST",
      credentials: "include",
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
    <form onSubmit={submit}>
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranchIcon />
            Git repository
          </CardTitle>
          <CardDescription>Import a repository and queue its first source revision.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={repositoryInvalid || undefined}>
              <FieldLabel htmlFor="git-url">Git repository URL</FieldLabel>
              <Input
                id="git-url"
                value={gitUrl}
                onChange={(event) => {
                  const nextUrl = event.target.value;
                  setGitUrl(nextUrl);
                  if (!nameEdited) setName(inferProjectSlugFromGitUrl(nextUrl) ?? "");
                }}
                aria-invalid={repositoryInvalid}
                placeholder="https://github.com/evelandhq/sample-office-assistant.git"
                autoComplete="url"
                required
              />
              <FieldDescription>HTTPS, SSH, and SCP-style Git addresses are supported.</FieldDescription>
              {repositoryInvalid ? <FieldError>Enter a Git repository URL with a repository name.</FieldError> : null}
            </Field>
            <Field data-invalid={nameInvalid || undefined}>
              <FieldLabel htmlFor="git-project-name">Project name</FieldLabel>
              <Input
                id="git-project-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameEdited(true);
                }}
                aria-invalid={nameInvalid}
                maxLength={PROJECT_SLUG_MAX_LENGTH}
                placeholder="sample-office-assistant"
                autoComplete="off"
                required
              />
              <FieldDescription>
                Suggested from the repository name. If it is already used, Eveland appends a numeric suffix.
              </FieldDescription>
              {nameInvalid ? <FieldError>{invalidNameMessage}</FieldError> : null}
            </Field>
            {error ? (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>Import failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={pending || repositoryInvalid || nameInvalid || !name}>
            {pending ? <Spinner data-icon="inline-start" /> : <GitBranchIcon data-icon="inline-start" />}
            {pending ? "Importing..." : "Import Git repository"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

function ZipProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [archive, setArchive] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nameInvalid =
    name.length > 0 && (name.length > PROJECT_SLUG_MAX_LENGTH || !PROJECT_SLUG_PATTERN.test(name));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!archive || !name || nameInvalid) return;

    setPending(true);
    setError(null);
    const form = new FormData();
    form.set("name", name);
    form.set("archive", archive);

    const response = await fetch(`${apiBaseUrl}/projects`, {
      method: "POST",
      credentials: "include",
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
    <form onSubmit={submit}>
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadIcon />
            Zip archive
          </CardTitle>
          <CardDescription>Upload a source snapshot when the project is not hosted in Git.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="source-archive">Source archive</FieldLabel>
              <Input
                id="source-archive"
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  const nextArchive = event.target.files?.[0] ?? null;
                  setArchive(nextArchive);
                  if (nextArchive && !nameEdited) {
                    try {
                      setName(slugifyProjectName(nextArchive.name.replace(/\.zip$/i, "")));
                    } catch {
                      setName("");
                    }
                  }
                }}
                required
              />
              <FieldDescription>The archive filename is used to suggest the project name.</FieldDescription>
            </Field>
            <Field data-invalid={nameInvalid || undefined}>
              <FieldLabel htmlFor="zip-project-name">Project name</FieldLabel>
              <Input
                id="zip-project-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameEdited(true);
                }}
                aria-invalid={nameInvalid}
                maxLength={PROJECT_SLUG_MAX_LENGTH}
                placeholder="support-analyst"
                autoComplete="off"
                required
              />
              <FieldDescription>If it is already used, Eveland appends a numeric suffix.</FieldDescription>
              {nameInvalid ? <FieldError>{invalidNameMessage}</FieldError> : null}
            </Field>
            {error ? (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>Upload failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button type="submit" variant="outline" className="w-full" disabled={pending || !archive || !name || nameInvalid}>
            {pending ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
            {pending ? "Uploading..." : "Upload Zip project"}
          </Button>
        </CardFooter>
      </Card>
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
