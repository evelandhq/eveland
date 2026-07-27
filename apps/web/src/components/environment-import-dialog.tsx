"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  EyeIcon,
  EyeOffIcon,
  FileUpIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  parseDotenvImport,
  type DotenvImportError,
} from "@/lib/environment-import";

export type EnvironmentImportEntry = {
  key: string;
  kind: "variable" | "secret";
  value: string;
};

type PreviewEntry = EnvironmentImportEntry & {
  line: number;
  visible: boolean;
};

const kindItems = [
  { label: "Secret", value: "secret" },
  { label: "Variable", value: "variable" },
] as const;

export function EnvironmentImportDialog({
  open,
  onOpenChange,
  existingKeys,
  onImport,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  existingKeys: string[];
  onImport(entries: EnvironmentImportEntry[]): Promise<void> | void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"input" | "preview">("input");
  const [source, setSource] = useState("");
  const [entries, setEntries] = useState<PreviewEntry[]>([]);
  const [parseErrors, setParseErrors] = useState<DotenvImportError[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const existingKeySet = new Set(existingKeys);
  const newCount = entries.filter((entry) => !existingKeySet.has(entry.key)).length;
  const overwriteCount = entries.length - newCount;
  const resultingCount = existingKeySet.size + newCount;
  const overLimit = resultingCount > 50;

  function reset() {
    setStep("input");
    setSource("");
    setEntries([]);
    setParseErrors([]);
    setInputError(null);
    setSubmitError(null);
    setSubmitting(false);
  }

  function changeOpen(nextOpen: boolean) {
    if (submitting) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  }

  function reviewSource(nextSource = source) {
    if (!nextSource.trim()) {
      setInputError("Paste .env contents or choose a .env file.");
      return;
    }
    const parsed = parseDotenvImport(nextSource);
    setEntries(parsed.entries.map((entry) => ({ ...entry, visible: false })));
    setParseErrors(parsed.errors);
    setInputError(null);
    setSubmitError(null);
    setStep("preview");
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_048_576) {
      setInputError("Choose a .env file smaller than 1 MiB.");
      return;
    }
    try {
      const contents = await file.text();
      setSource(contents);
      reviewSource(contents);
    } catch {
      setInputError("The .env file could not be read.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function updateKind(key: string, kind: "variable" | "secret") {
    setEntries((current) => current.map((entry) =>
      entry.key === key ? { ...entry, kind, visible: kind === "variable" ? true : entry.visible } : entry));
  }

  function toggleVisible(key: string) {
    setEntries((current) => current.map((entry) =>
      entry.key === key ? { ...entry, visible: !entry.visible } : entry));
  }

  async function submitImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (parseErrors.length > 0 || overLimit || entries.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onImport(entries.map(({ key, kind, value }) => ({ key, kind, value })));
      reset();
      onOpenChange(false);
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : "Environment variables could not be imported.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {step === "input" ? "Import environment variables" : "Review environment variables"}
          </DialogTitle>
          <DialogDescription>
            {step === "input"
              ? "Paste .env contents or upload a file. Values stay in this browser until you confirm."
              : "Confirm exact values and choose whether each entry is a secret or plain variable."}
          </DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait" initial={false}>
          {step === "input" ? (
            <motion.form
              key="input"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.16 }}
              className="flex flex-col gap-6"
              onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                event.stopPropagation();
                reviewSource();
              }}
            >
              <FieldGroup>
                <Field data-invalid={Boolean(inputError) || undefined}>
                  <FieldLabel htmlFor="dotenv-contents">.env contents</FieldLabel>
                  <Textarea
                    id="dotenv-contents"
                    value={source}
                    onChange={(event) => {
                      setSource(event.target.value);
                      setInputError(null);
                    }}
                    aria-invalid={Boolean(inputError)}
                    className="max-h-[40svh] min-h-52 overflow-y-auto font-mono text-xs"
                    placeholder={"OPENAI_API_KEY=sk-...\nMODEL_NAME=\"gpt-5.4\""}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <FieldDescription>
                    One KEY=value pair per line. Blank lines and # comments are ignored; export prefixes are accepted.
                  </FieldDescription>
                  {inputError ? <FieldError>{inputError}</FieldError> : null}
                </Field>
              </FieldGroup>
              <input
                ref={fileInputRef}
                type="file"
                accept=".env,text/plain"
                hidden
                onChange={(event) => void readFile(event.target.files?.[0])}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUpIcon data-icon="inline-start" />
                  Import .env
                </Button>
                <Button type="submit">Review variables</Button>
              </DialogFooter>
            </motion.form>
          ) : (
            <motion.form
              key="preview"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.16 }}
              className="flex min-h-0 flex-col gap-5"
              onSubmit={submitImport}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{entries.length} parsed</span>
                {newCount > 0 ? <Badge variant="secondary">{newCount} New</Badge> : null}
                {overwriteCount > 0 ? <Badge variant="outline">{overwriteCount} Overwrite</Badge> : null}
              </div>

              {parseErrors.length > 0 ? (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Fix {parseErrors.length} invalid line{parseErrors.length === 1 ? "" : "s"}</AlertTitle>
                  <AlertDescription>
                    <ul className="flex list-disc flex-col gap-1 pl-4">
                      {parseErrors.map((error) => (
                        <li key={`${error.line}-${error.message}`}>Line {error.line}: {error.message}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}

              {overLimit ? (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Project environment limit exceeded</AlertTitle>
                  <AlertDescription>
                    This import would create {resultingCount} entries. A project can have at most 50.
                  </AlertDescription>
                </Alert>
              ) : null}

              {submitError ? (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>Import failed</AlertTitle>
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="max-h-[45vh] overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32">Type</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead className="w-24">Change</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => (
                      <TableRow key={entry.key}>
                        <TableCell>
                          <Select
                            items={kindItems}
                            value={entry.kind}
                            onValueChange={(value) => {
                              if (value === "variable" || value === "secret") updateKind(entry.key, value);
                            }}
                            disabled={submitting}
                          >
                            <SelectTrigger size="sm" aria-label={`Type for ${entry.key}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent alignItemWithTrigger={false}>
                              <SelectGroup>
                                {kindItems.map((item) => (
                                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="font-mono text-xs font-medium">{entry.key}</TableCell>
                        <TableCell>
                          <InputGroup>
                            <InputGroupInput
                              aria-label={`Value for ${entry.key}`}
                              type={entry.kind === "variable" || entry.visible ? "text" : "password"}
                              value={entry.value}
                              readOnly
                              className="font-mono text-xs"
                            />
                            {entry.kind === "secret" ? (
                              <InputGroupAddon align="inline-end">
                                <InputGroupButton
                                  size="icon-xs"
                                  aria-label={entry.visible ? `Hide ${entry.key}` : `Show ${entry.key}`}
                                  onClick={() => toggleVisible(entry.key)}
                                >
                                  {entry.visible ? <EyeOffIcon /> : <EyeIcon />}
                                </InputGroupButton>
                              </InputGroupAddon>
                            ) : null}
                          </InputGroup>
                        </TableCell>
                        <TableCell>
                          <Badge variant={existingKeySet.has(entry.key) ? "outline" : "secondary"}>
                            {existingKeySet.has(entry.key) ? "Overwrite" : "New"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting}
                  onClick={() => {
                    setStep("input");
                    setSubmitError(null);
                  }}
                >
                  <ArrowLeftIcon data-icon="inline-start" />
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={submitting || parseErrors.length > 0 || overLimit || entries.length === 0}
                >
                  {submitting ? <Spinner data-icon="inline-start" /> : null}
                  {submitting ? "Importing…" : `Import ${entries.length} variable${entries.length === 1 ? "" : "s"}`}
                </Button>
              </DialogFooter>
            </motion.form>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
