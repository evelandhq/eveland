"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  LockKeyholeIcon,
  PencilIcon,
  PlusIcon,
  RocketIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import {
  inferProjectSlugFromGitUrl,
  normalizeGitHttpHost,
  PROJECT_SLUG_MAX_LENGTH,
  PROJECT_SLUG_PATTERN,
} from "@eveland/core/ids";
import type { PublicGitCredential, SourcePreflight } from "@eveland/core/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getGitCredentials } from "@/lib/client-api";
import type { AgentEndpoints, Job, LogLine, Project } from "@/lib/api";
import { getNewProjectProgress, validateNewProjectEnvironmentVariables } from "@/lib/new-project";
import { cn } from "@/lib/utils";
import {
  browserGet,
  browserGetOptional,
  readError,
  safeProjectSlug,
  uploadZipPreflight,
} from "./new-project-flow-api";
import {
  DeploymentStage,
  SourceSummary,
  StepIndicator,
  type NewProjectSourceKind as SourceKind,
  type NewProjectStep as Step,
} from "./new-project-flow-parts";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const invalidNameMessage = "Use lowercase letters, numbers, and hyphens, with no leading or trailing hyphen.";

type Availability = "idle" | "checking" | "available" | "unavailable" | "error";
type EnvironmentVariableDraft = { id: number; key: string; value: string; visible: boolean };
type EnvironmentVariableDraftErrors = { key?: string; value?: string };

export function NewProjectFlow() {
  const [step, setStep] = useState<Step>("source");
  const [sourceKind, setSourceKind] = useState<SourceKind>("git");
  const [gitUrl, setGitUrl] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [gitlabPat, setGitlabPat] = useState("");
  const [preflight, setPreflight] = useState<SourcePreflight | null>(null);
  const [savedCredentials, setSavedCredentials] = useState<PublicGitCredential[]>([]);
  const [availability, setAvailability] = useState<Availability>("idle");
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environmentVariables, setEnvironmentVariables] = useState<EnvironmentVariableDraft[]>([]);
  const [environmentDialogOpen, setEnvironmentDialogOpen] = useState(false);
  const [editingEnvironmentVariableId, setEditingEnvironmentVariableId] = useState<number | null>(null);
  const [environmentDraft, setEnvironmentDraft] = useState<EnvironmentVariableDraft | null>(null);
  const [environmentDraftErrors, setEnvironmentDraftErrors] = useState<EnvironmentVariableDraftErrors>({});
  const [pending, setPending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [endpoints, setEndpoints] = useState<AgentEndpoints>({ stable: null, previews: [] });
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const nextEnvironmentVariableId = useRef(1);

  const inferredGitName = inferProjectSlugFromGitUrl(gitUrl);
  const inferredZipName = archive ? safeProjectSlug(archive.name.replace(/\.zip$/i, "")) : null;
  const repositoryInvalid = sourceKind === "git" && gitUrl.length > 0 && inferredGitName === null;
  const nameInvalid = name.length > 0 && (name.length > PROJECT_SLUG_MAX_LENGTH || !PROJECT_SLUG_PATTERN.test(name));
  const gitHost = sourceKind === "git" ? normalizeGitHttpHost(gitUrl) : null;
  const savedCredential = savedCredentials.find((credential) => credential.host === gitHost);
  const patUnsupported = sourceKind === "git" && gitlabPat.length > 0 && gitHost === null;
  const progress = useMemo(() => getNewProjectProgress(project, jobs), [jobs, project]);
  const environmentValidation = useMemo(
    () => validateNewProjectEnvironmentVariables(environmentVariables),
    [environmentVariables],
  );

  useEffect(() => {
    if (step !== "source" || !preflight || !["queued", "running"].includes(preflight.status)) return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await browserGet<{ preflight: SourcePreflight }>(`/source-preflights/${preflight.id}`);
        if (cancelled) return;
        setPreflight(result.preflight);
        if (result.preflight.status === "completed") {
          const inferred = sourceKind === "git" ? inferredGitName : inferredZipName;
          if (inferred) setName(inferred);
          setStep("configure");
        }
      } catch (error) {
        if (!cancelled) setCreateError(error instanceof Error ? error.message : "Could not refresh source validation.");
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 900);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [inferredGitName, inferredZipName, preflight?.id, preflight?.status, sourceKind, step]);

  useEffect(() => {
    let cancelled = false;
    void getGitCredentials()
      .then((credentials) => {
        if (!cancelled) setSavedCredentials(credentials);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (step !== "configure" || !name || nameInvalid) {
      setAvailability("idle");
      setAvailabilityError(null);
      return;
    }

    const controller = new AbortController();
    setAvailability("checking");
    setAvailabilityError(null);
    const timeout = window.setTimeout(() => {
      void fetch(`${apiBaseUrl}/projects/name-availability?name=${encodeURIComponent(name)}`, {
        credentials: "include",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readError(response, "Could not check the project name."));
          return response.json() as Promise<{ available: boolean }>;
        })
        .then((result) => setAvailability(result.available ? "available" : "unavailable"))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setAvailability("error");
          setAvailabilityError(error instanceof Error ? error.message : "Could not check the project name.");
        });
    }, 300);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [name, nameInvalid, step]);

  useEffect(() => {
    if (step !== "deploy" || !project?.id) return;
    if (progress.phase === "failed" || (progress.phase === "ready" && endpoints.stable)) return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const [projectResult, jobsResult, logsResult, endpointsResult] = await Promise.all([
          browserGet<{ project: Project }>(`/projects/${project.id}`),
          browserGet<{ jobs: Job[] }>(`/projects/${project.id}/jobs?include=deployment`),
          browserGet<{ logs: LogLine[] }>(`/projects/${project.id}/logs`),
          browserGetOptional<AgentEndpoints>(`/projects/${project.id}/endpoints`),
        ]);
        if (cancelled) return;
        setProject(projectResult.project);
        setJobs(jobsResult.jobs);
        setLogs(logsResult.logs);
        setEndpoints(endpointsResult ?? { stable: null, previews: [] });
      } catch (error) {
        if (!cancelled) setCreateError(error instanceof Error ? error.message : "Could not refresh deployment status.");
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [endpoints.stable, progress.phase, project?.id, step]);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, progress.detail]);

  async function continueFromSource(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sourceKind === "git") {
      if (!inferredGitName || repositoryInvalid || patUnsupported) return;
    } else {
      if (!archive || !inferredZipName) return;
    }
    setCreateError(null);
    setPending(true);
    try {
      const response = sourceKind === "git"
        ? await fetch(`${apiBaseUrl}/source-preflights`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "git", gitUrl, ...(gitlabPat ? { gitlabPat } : {}) }),
          })
        : await uploadZipPreflight(archive!);
      if (!response.ok) throw new Error(await readError(response, "Could not validate the source."));
      const body = (await response.json()) as { preflight: SourcePreflight };
      setPreflight(body.preflight);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not reach the Eveland API.");
    } finally {
      setPending(false);
    }
  }

  async function deploy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !preflight
      || preflight.status !== "completed"
      || !name
      || nameInvalid
      || availability !== "available"
      || environmentValidation.invalid
    ) return;

    setPending(true);
    setCreateError(null);
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl}/projects`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          preflightId: preflight.id,
          deployAfterImport: true,
          environmentVariables: environmentValidation.variables.map((variable) => ({
            key: variable.key.trim(),
            value: variable.value,
          })),
        }),
      });
    } catch {
      setPending(false);
      setCreateError("Could not reach the Eveland API.");
      return;
    }

    setPending(false);
    if (!response.ok) {
      const message = await readError(response, "Could not create the project.");
      setCreateError(message);
      if (response.status === 409 && message.toLowerCase().includes("name")) setAvailability("unavailable");
      return;
    }

    const body = (await response.json()) as { project: Project };
    setProject(body.project);
    setJobs([]);
    setLogs([]);
    setStep("deploy");
  }

  function addEnvironmentVariable() {
    setEnvironmentOpen(true);
    setEditingEnvironmentVariableId(null);
    setEnvironmentDraft({ id: nextEnvironmentVariableId.current++, key: "", value: "", visible: false });
    setEnvironmentDraftErrors({});
    setEnvironmentDialogOpen(true);
  }

  function editEnvironmentVariable(variable: EnvironmentVariableDraft) {
    setEditingEnvironmentVariableId(variable.id);
    setEnvironmentDraft({ ...variable, visible: false });
    setEnvironmentDraftErrors({});
    setEnvironmentDialogOpen(true);
  }

  function updateEnvironmentDraft(patch: Partial<EnvironmentVariableDraft>) {
    setEnvironmentDraft((current) => current ? { ...current, ...patch } : current);
    setEnvironmentDraftErrors({});
  }

  function removeEnvironmentVariable(id: number) {
    setEnvironmentVariables((current) => current.filter((variable) => variable.id !== id));
  }

  function setEnvironmentVariablesOpen(open: boolean) {
    setEnvironmentOpen(open);
  }

  function submitEnvironmentVariable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!environmentDraft) return;
    const nextVariables = editingEnvironmentVariableId === null
      ? [...environmentVariables, environmentDraft]
      : environmentVariables.map((variable) =>
          variable.id === editingEnvironmentVariableId ? environmentDraft : variable);
    const validation = validateNewProjectEnvironmentVariables(nextVariables);
    const draftErrors = validation.errors.get(environmentDraft.id) ?? {};
    if (!environmentDraft.key.trim() && !environmentDraft.value) {
      setEnvironmentDraftErrors({ key: "Enter a variable name.", value: "Enter a value." });
      return;
    }
    if (draftErrors.key || draftErrors.value) {
      setEnvironmentDraftErrors(draftErrors);
      return;
    }
    setEnvironmentVariables(nextVariables);
    setEnvironmentDialogOpen(false);
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col px-5 py-10 sm:px-8 sm:py-16">
      <StepIndicator step={step} />
      <AnimatePresence mode="wait" initial={false}>
        {step === "source" ? (
          <motion.section
            key="source"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="mx-auto flex w-full max-w-2xl flex-col gap-10 pt-12 sm:pt-16"
          >
            <header className="flex flex-col gap-3">
              <p className="text-sm font-medium text-primary">Create project</p>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Bring your Eve agent online.</h1>
              <p className="max-w-xl text-base text-muted-foreground">
                Start from a GitHub or GitLab repository, or upload the same Zip source you use today.
              </p>
            </header>

            {preflight && ["queued", "running"].includes(preflight.status) ? (
              <section className="flex flex-col gap-5 rounded-xl border bg-card p-6" aria-live="polite">
                <div className="flex items-start gap-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Spinner />
                  </div>
                  <div className="flex flex-col gap-1">
                    <h2 className="font-semibold">Checking Eve compatibility</h2>
                    <p className="text-sm text-muted-foreground">
                      {preflight.status === "queued"
                        ? "Waiting for a worker to inspect the source…"
                        : "Reading the project layout and verifying the Eve version…"}
                    </p>
                  </div>
                </div>
                <SourceSummary sourceKind={sourceKind} gitUrl={gitUrl} archive={archive} />
              </section>
            ) : preflight?.status === "failed" ? (
              <div className="flex flex-col gap-4">
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Source validation failed</AlertTitle>
                  <AlertDescription>{preflight.error ?? "This source is not a supported Eve project."}</AlertDescription>
                </Alert>
                <Button type="button" variant="outline" onClick={() => { setPreflight(null); setCreateError(null); }}>
                  <ArrowLeftIcon data-icon="inline-start" />
                  Choose another source
                </Button>
              </div>
            ) : (
            <form onSubmit={continueFromSource} className="flex flex-col gap-8">
              <FieldGroup>
                <Field data-invalid={repositoryInvalid || undefined}>
                  <FieldLabel htmlFor="git-url">Git repository URL</FieldLabel>
                  <Input
                    id="git-url"
                    value={gitUrl}
                    onChange={(event) => {
                      setGitUrl(event.target.value);
                      setSourceKind("git");
                    }}
                    aria-invalid={repositoryInvalid}
                    placeholder="https://github.com/evelandhq/sample-office-assistant.git"
                    autoComplete="url"
                  />
                  <FieldDescription>GitHub, GitLab, HTTPS, SSH, and SCP-style addresses are supported.</FieldDescription>
                  {repositoryInvalid ? <FieldError>Enter a Git repository URL with a repository name.</FieldError> : null}
                </Field>
                {sourceKind === "git" ? (
                  <Field data-invalid={patUnsupported || undefined}>
                    <FieldLabel htmlFor="gitlab-pat">GitLab personal access token</FieldLabel>
                    <Input
                      id="gitlab-pat"
                      type="password"
                      value={gitlabPat}
                      onChange={(event) => setGitlabPat(event.target.value)}
                      aria-invalid={patUnsupported}
                      autoComplete="off"
                      placeholder={savedCredential ? "Saved PAT will be reused" : "glpat-…"}
                    />
                    <FieldDescription>
                      {savedCredential && !gitlabPat
                        ? `A saved PAT for ${savedCredential.host} will be reused during validation.`
                        : "Optional for private GitLab repositories. Use read_repository scope."}
                    </FieldDescription>
                    {patUnsupported ? <FieldError>PAT authentication requires an HTTPS URL without embedded credentials.</FieldError> : null}
                  </Field>
                ) : null}
              </FieldGroup>

              <div className="flex items-center gap-4" aria-hidden="true">
                <Separator className="flex-1" />
                <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">or</span>
                <Separator className="flex-1" />
              </div>

              <FieldGroup>
                <Field data-invalid={sourceKind === "zip" && archive !== null && inferredZipName === null || undefined}>
                  <FieldLabel htmlFor="source-archive">Upload a Zip archive</FieldLabel>
                  <Input
                    id="source-archive"
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(event) => {
                      const nextArchive = event.target.files?.[0] ?? null;
                      setArchive(nextArchive);
                      if (nextArchive) setSourceKind("zip");
                    }}
                  />
                  <FieldDescription>{archive ? `${archive.name} selected` : "Choose a source snapshot from your computer."}</FieldDescription>
                  {sourceKind === "zip" && archive && !inferredZipName ? (
                    <FieldError>The archive filename must contain at least one letter or number.</FieldError>
                  ) : null}
                </Field>
              </FieldGroup>

              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={pending || (sourceKind === "git" ? !inferredGitName || repositoryInvalid || patUnsupported : !archive || !inferredZipName)}
              >
                {pending ? <Spinner data-icon="inline-start" /> : <ArrowRightIcon data-icon="inline-start" />}
                {pending ? "Submitting source…" : "Validate source"}
              </Button>
              {createError ? (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Source could not be submitted</AlertTitle>
                  <AlertDescription>{createError}</AlertDescription>
                </Alert>
              ) : null}
            </form>
            )}
          </motion.section>
        ) : null}

        {step === "configure" ? (
          <motion.section
            key="configure"
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.22 }}
            className="mx-auto flex w-full max-w-2xl flex-col gap-8 pt-12"
          >
            <header className="flex flex-col gap-3">
              <Button type="button" variant="ghost" className="w-fit" onClick={() => { setPreflight(null); setStep("source"); }}>
                <ArrowLeftIcon data-icon="inline-start" />
                Change source
              </Button>
              <h1 className="text-3xl font-semibold tracking-tight">Name and deploy your project.</h1>
              <p className="text-muted-foreground">The name becomes the permanent public address for this agent.</p>
            </header>

            <SourceSummary sourceKind={sourceKind} gitUrl={gitUrl} archive={archive} preflight={preflight} />

            <form onSubmit={deploy} className="flex flex-col gap-8">
              <FieldGroup>
                <Field data-invalid={nameInvalid || availability === "unavailable" || availability === "error" || undefined}>
                  <FieldLabel htmlFor="project-name">Project name</FieldLabel>
                  <Input
                    id="project-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-invalid={nameInvalid || availability === "unavailable" || availability === "error"}
                    maxLength={PROJECT_SLUG_MAX_LENGTH}
                    autoComplete="off"
                    required
                  />
                  {!nameInvalid && availability === "checking" ? (
                    <FieldDescription className="flex items-center gap-2"><Spinner /> Checking availability…</FieldDescription>
                  ) : null}
                  {!nameInvalid && availability === "available" ? (
                    <FieldDescription className="flex items-center gap-2"><CheckIcon /> This name is available.</FieldDescription>
                  ) : null}
                  {nameInvalid ? <FieldError>{invalidNameMessage}</FieldError> : null}
                  {availability === "unavailable" ? <FieldError>This project name is already in use.</FieldError> : null}
                  {availability === "error" ? <FieldError>{availabilityError}</FieldError> : null}
                </Field>

              </FieldGroup>

              <Collapsible
                open={environmentOpen}
                onOpenChange={setEnvironmentVariablesOpen}
                className="overflow-hidden rounded-xl border bg-card"
              >
                <CollapsibleTrigger type="button" className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-medium">Environment variables</span>
                    <span className="text-sm font-normal text-muted-foreground">
                      Optional secrets and runtime configuration for the first deployment.
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    {environmentValidation.variables.length > 0 ? (
                      <span className="text-xs tabular-nums">{environmentValidation.variables.length} added</span>
                    ) : null}
                    <ChevronDownIcon className={cn("size-4 transition-transform", environmentOpen && "rotate-180")} />
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2">
                  <div className="flex flex-col gap-5 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <p className="text-sm text-muted-foreground">
                        Add provider keys such as <code className="font-mono text-foreground">OPENAI_API_KEY</code>. Values are encrypted before they are stored.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        disabled={environmentVariables.length >= 50}
                        onClick={addEnvironmentVariable}
                      >
                        <PlusIcon data-icon="inline-start" />
                        Add variable
                      </Button>
                    </div>

                    <div className="overflow-hidden rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-28">Type</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Value</TableHead>
                            <TableHead className="w-24"><span className="sr-only">Actions</span></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {environmentVariables.length === 0 ? (
                            <TableRow className="hover:bg-transparent">
                              <TableCell colSpan={4}>
                                <Empty className="border-0 py-9">
                                  <EmptyHeader>
                                    <EmptyMedia variant="icon"><LockKeyholeIcon /></EmptyMedia>
                                    <EmptyTitle>No environment variables</EmptyTitle>
                                    <EmptyDescription>Add only the secrets or runtime configuration this project needs.</EmptyDescription>
                                  </EmptyHeader>
                                </Empty>
                              </TableCell>
                            </TableRow>
                          ) : environmentVariables.map((variable) => (
                            <TableRow key={variable.id}>
                              <TableCell><Badge variant="secondary">Secret</Badge></TableCell>
                              <TableCell className="font-mono text-xs font-medium">{variable.key}</TableCell>
                              <TableCell>
                                <span className="inline-flex items-center gap-2 text-muted-foreground">
                                  <LockKeyholeIcon className="size-4" />
                                  ••••••••
                                </span>
                              </TableCell>
                              <TableCell>
                                <div className="flex justify-end gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Edit variable ${variable.key}`}
                                    title="Edit variable"
                                    onClick={() => editEnvironmentVariable(variable)}
                                  >
                                    <PencilIcon />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Remove variable ${variable.key}`}
                                    title="Remove variable"
                                    onClick={() => removeEnvironmentVariable(variable.id)}
                                  >
                                    <Trash2Icon />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="text-xs text-muted-foreground">Available to preview and stable deployments.</p>
                  </div>
                </CollapsibleContent>
              </Collapsible>

              <Dialog
                open={environmentDialogOpen}
                onOpenChange={(open) => {
                  setEnvironmentDialogOpen(open);
                  if (!open) setEnvironmentDraftErrors({});
                }}
              >
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{editingEnvironmentVariableId === null ? "Add variable" : "Edit variable"}</DialogTitle>
                    <DialogDescription>
                      Values are held only for this setup flow and encrypted when the project is created.
                    </DialogDescription>
                  </DialogHeader>
                  {environmentDraft ? (
                    <form className="flex flex-col gap-6" onSubmit={submitEnvironmentVariable}>
                      <FieldGroup>
                        <Field data-invalid={Boolean(environmentDraftErrors.key) || undefined}>
                          <FieldLabel htmlFor={`environment-key-${environmentDraft.id}`}>Name</FieldLabel>
                          <Input
                            id={`environment-key-${environmentDraft.id}`}
                            value={environmentDraft.key}
                            onChange={(event) => updateEnvironmentDraft({ key: event.target.value.toUpperCase() })}
                            aria-invalid={Boolean(environmentDraftErrors.key)}
                            autoCapitalize="characters"
                            autoComplete="off"
                            spellCheck={false}
                            className="font-mono"
                            placeholder="OPENAI_API_KEY"
                          />
                          <FieldDescription>Use uppercase letters, numbers, and underscores.</FieldDescription>
                          {environmentDraftErrors.key ? <FieldError>{environmentDraftErrors.key}</FieldError> : null}
                        </Field>

                        <Field data-invalid={Boolean(environmentDraftErrors.value) || undefined}>
                          <FieldLabel htmlFor={`environment-value-${environmentDraft.id}`}>Value</FieldLabel>
                          <div className="relative">
                            <Input
                              id={`environment-value-${environmentDraft.id}`}
                              type={environmentDraft.visible ? "text" : "password"}
                              value={environmentDraft.value}
                              onChange={(event) => updateEnvironmentDraft({ value: event.target.value })}
                              aria-invalid={Boolean(environmentDraftErrors.value)}
                              autoComplete="new-password"
                              className="pr-10"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                              aria-label={environmentDraft.visible ? "Hide value" : "Show value"}
                              onClick={() => updateEnvironmentDraft({ visible: !environmentDraft.visible })}
                            >
                              {environmentDraft.visible ? <EyeOffIcon /> : <EyeIcon />}
                            </Button>
                          </div>
                          {environmentDraftErrors.value ? <FieldError>{environmentDraftErrors.value}</FieldError> : null}
                        </Field>
                      </FieldGroup>
                      <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setEnvironmentDialogOpen(false)}>Cancel</Button>
                        <Button type="submit">
                          {editingEnvironmentVariableId === null ? "Add variable" : "Save changes"}
                        </Button>
                      </DialogFooter>
                    </form>
                  ) : null}
                </DialogContent>
              </Dialog>

              {createError ? (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Project could not be created</AlertTitle>
                  <AlertDescription>{createError}</AlertDescription>
                </Alert>
              ) : null}

              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={pending || nameInvalid || availability !== "available" || environmentValidation.invalid}
              >
                {pending ? <Spinner data-icon="inline-start" /> : <RocketIcon data-icon="inline-start" />}
                {pending ? "Starting deployment…" : "Deploy"}
              </Button>
            </form>
          </motion.section>
        ) : null}

        {step === "deploy" && project ? (
          <motion.section
            key="deploy"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="flex flex-col gap-8 pt-10"
          >
            <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-primary">{project.name}</p>
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                  {progress.phase === "ready" ? "Deployment complete." : progress.phase === "failed" ? "Deployment needs attention." : "Deploying your agent…"}
                </h1>
                <p className="text-muted-foreground">{progress.detail}</p>
              </div>
              <Link href={`/projects/${project.id}`} className={buttonVariants({ variant: "outline" })}>
                View project
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </header>

            <ol className="grid gap-3 sm:grid-cols-2">
              <DeploymentStage
                label="Import source"
                complete={Boolean(project.sourceRevisionId) || jobs.some((job) => job.type === "import_source" && job.status === "completed")}
                failed={jobs.some((job) => job.type === "import_source" && job.status === "failed")}
                active={!project.sourceRevisionId && progress.phase === "importing"}
              />
              <DeploymentStage
                label="Build and deploy"
                complete={progress.phase === "ready"}
                failed={jobs.some((job) => job.type === "build_deploy" && job.status === "failed")}
                active={progress.phase === "deploying"}
              />
            </ol>

            <section className="overflow-hidden rounded-xl border bg-foreground text-background">
              <div className="flex items-center justify-between border-b border-background/15 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <TerminalIcon className="size-4" />
                  Deployment logs
                </div>
                {progress.phase === "importing" || progress.phase === "deploying" ? <Spinner /> : <Badge variant="secondary">{progress.phase}</Badge>}
              </div>
              <div ref={logRef} className="h-72 overflow-y-auto px-4 py-4 font-mono text-xs leading-6" aria-live="polite">
                {logs.length === 0 ? <p className="text-background/65">{progress.detail}</p> : null}
                {logs.map((log) => (
                  <p key={log.id} className="grid grid-cols-[5.5rem_1fr] gap-3">
                    <time className="text-background/45" dateTime={log.createdAt}>
                      {new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </time>
                    <span className="whitespace-pre-wrap break-words">{log.line}</span>
                  </p>
                ))}
              </div>
            </section>

            {progress.phase === "failed" ? (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>Deployment failed</AlertTitle>
                <AlertDescription>{progress.detail} Your project and logs have been preserved.</AlertDescription>
              </Alert>
            ) : null}

            {progress.phase === "ready" && endpoints.stable ? (
              <motion.section
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col gap-5 rounded-xl border bg-card p-5 sm:p-6"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <CheckIcon className="size-5 text-primary" />
                    <h2 className="text-lg font-semibold">Your agent is live</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">Use this stable URL to connect to the deployed agent.</p>
                </div>
                <div className="flex flex-col gap-3 rounded-lg bg-muted p-4 sm:flex-row sm:items-center sm:justify-between">
                  <code className="break-all text-sm">{endpoints.stable}</code>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={async () => {
                      await navigator.clipboard.writeText(endpoints.stable!);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1800);
                    }}
                  >
                    {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
                    {copied ? "Copied" : "Copy URL"}
                  </Button>
                </div>
                <Link href={`/projects/${project.id}`} className={cn(buttonVariants(), "w-full sm:w-fit")}>
                  View project details
                  <ArrowRightIcon data-icon="inline-end" />
                </Link>
              </motion.section>
            ) : null}
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
