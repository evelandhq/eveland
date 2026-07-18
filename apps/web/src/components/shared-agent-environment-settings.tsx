"use client";

import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { SharedAgentEnvironment } from "@eveland/core/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { saveSharedAgentEnvironment } from "@/lib/client-api";
import {
  validateSharedAgentEnvironmentDraft,
  updateSharedAgentEnvironmentEntry,
  type SharedAgentEnvironmentDraft,
} from "@/lib/shared-agent-environment";

const kindItems = [
  { label: "Secret", value: "secret" },
  { label: "Variable", value: "variable" },
] as const;

const emptyEntry = (): SharedAgentEnvironmentDraft["entries"][number] => ({
  key: "",
  kind: "secret",
  value: "",
  configured: false,
});

export function SharedAgentEnvironmentSettings({
  initialEnvironment,
}: {
  initialEnvironment: SharedAgentEnvironment | null;
}) {
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [entries, setEntries] = useState<SharedAgentEnvironmentDraft["entries"]>(
    initialEnvironment?.entries.map((entry) => ({ ...entry, value: "" })) ?? [emptyEntry()],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function updateEntry(index: number, patch: Partial<SharedAgentEnvironmentDraft["entries"][number]>) {
    setEntries((current) => current.map((entry, entryIndex) =>
      entryIndex === index ? updateSharedAgentEnvironmentEntry(entry, patch) : entry));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validated = validateSharedAgentEnvironmentDraft({ entries });
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveSharedAgentEnvironment(validated.input.entries);
      setEnvironment(result.environment);
      setEntries(result.environment.entries.map((entry) => ({ ...entry, value: "" })));
      setNotice(result.jobs.length > 0
        ? `Shared environment saved. ${result.jobs.length} live deployment restart${result.jobs.length === 1 ? "" : "s"} queued.`
        : "Shared environment saved. Agent Deployments will use it the next time their process starts.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the shared Agent environment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shared Agent environment</CardTitle>
        <CardDescription>
          Configure fallback values such as shared LLM keys. Project Secrets override matching keys.
          Values stay encrypted and are materialized automatically for every Agent process.
        </CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent className="flex flex-col gap-4">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
          {environment ? (
            <p className="text-sm text-muted-foreground">Current revision: r{environment.revision}</p>
          ) : null}
          <FieldGroup>
            {entries.map((entry, index) => (
              <Field key={index}>
                <FieldLabel>Entry {index + 1}</FieldLabel>
                <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                  <Input
                    aria-label={`Entry ${index + 1} key`}
                    value={entry.key}
                    onChange={(event) => updateEntry(index, { key: event.target.value.toUpperCase() })}
                    placeholder="OPENAI_API_KEY"
                  />
                  <Select
                    items={kindItems}
                    value={entry.kind}
                    onValueChange={(value) => {
                      if (value === "variable" || value === "secret") updateEntry(index, { kind: value });
                    }}
                  >
                    <SelectTrigger aria-label={`Entry ${index + 1} kind`} className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {kindItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  aria-label={`Entry ${index + 1} value`}
                  type={entry.kind === "secret" ? "password" : "text"}
                  autoComplete="new-password"
                  value={entry.value}
                  onChange={(event) => updateEntry(index, { value: event.target.value })}
                  placeholder={entry.configured ? "Configured — leave blank to keep" : "Value"}
                />
                {entry.configured ? (
                  <FieldDescription>Configured; the value is not available to this browser.</FieldDescription>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEntries((current) => current.filter((_, entryIndex) => entryIndex !== index))}
                >
                  <Trash2Icon data-icon="inline-start" />
                  Remove entry
                </Button>
              </Field>
            ))}
            <Button type="button" variant="outline" onClick={() => setEntries((current) => [...current, emptyEntry()])}>
              <PlusIcon data-icon="inline-start" />
              Add entry
            </Button>
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Save shared environment
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
