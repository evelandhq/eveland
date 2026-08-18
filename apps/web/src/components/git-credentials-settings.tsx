"use client";

import { useId, useState } from "react";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { PublicGitCredential } from "@evelandhq/core/contracts";
import { normalizeGitCredentialHost } from "@evelandhq/core/ids";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createGitCredential, deleteGitCredential } from "@/lib/client-api";

export function GitCredentialsSettings({
  initialCredentials,
}: {
  initialCredentials: PublicGitCredential[];
}) {
  const hostId = useId();
  const patId = useId();
  const [credentials, setCredentials] = useState(initialCredentials);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [hostInput, setHostInput] = useState("");
  const [patInput, setPatInput] = useState("");

  function openAddDialog() {
    setHostInput("");
    setPatInput("");
    setDialogError(null);
    setDialogOpen(true);
  }

  async function submitCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const host = normalizeGitCredentialHost(hostInput);
    if (!host) {
      setDialogError(
        "Enter an HTTPS Git host like gitlab.example.com, without a path or embedded credentials.",
      );
      return;
    }
    if (!patInput) {
      setDialogError("Enter a personal access token.");
      return;
    }
    setPending(true);
    setDialogError(null);
    setError(null);
    try {
      const credential = await createGitCredential({ host, gitlabPat: patInput });
      setCredentials((current) =>
        current.some((existing) => existing.host === credential.host)
          ? current.map((existing) => (existing.host === credential.host ? credential : existing))
          : [credential, ...current],
      );
      setDialogOpen(false);
    } catch (caught) {
      setDialogError(
        caught instanceof Error ? caught.message : "Could not save the Git credential.",
      );
    } finally {
      setPending(false);
    }
  }

  async function removeCredential(credentialId: string) {
    setDeletingId(credentialId);
    setError(null);
    try {
      await deleteGitCredential(credentialId);
      setCredentials((current) => current.filter((credential) => credential.id !== credentialId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the Git credential.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Saved hosts</CardTitle>
          <CardDescription>
            PATs are encrypted and scoped to your account. Add one here, or enter it while importing
            a private repository.
          </CardDescription>
          <CardAction>
            <Button type="button" size="sm" onClick={openAddDialog}>
              <PlusIcon data-icon="inline-start" />
              Add credential
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {credentials.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>No saved Git credentials</EmptyTitle>
                <EmptyDescription>
                  Add a host and PAT here, or enter a GitLab PAT while importing a private
                  repository.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((credential) => (
                  <TableRow key={credential.id}>
                    <TableCell className="font-medium">{credential.host}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">Encrypted</Badge>
                    </TableCell>
                    <TableCell>
                      <DateTime value={credential.updatedAt} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={deletingId === credential.id}
                        onClick={() => void removeCredential(credential.id)}
                      >
                        {deletingId === credential.id ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <Trash2Icon data-icon="inline-start" />
                        )}
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!pending) setDialogOpen(open);
          if (!open) setDialogError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add credential</DialogTitle>
            <DialogDescription>
              Save a PAT for a Git HTTPS host. Adding a host that is already saved replaces its PAT.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-6" onSubmit={submitCredential}>
            {dialogError ? (
              <Alert variant="destructive">
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            ) : null}
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={hostId}>Host</FieldLabel>
                <Input
                  id={hostId}
                  value={hostInput}
                  onChange={(event) => setHostInput(event.target.value)}
                  placeholder="gitlab.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                />
                <FieldDescription>
                  The HTTPS host of your Git server, with an optional port.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={patId}>GitLab personal access token</FieldLabel>
                <Input
                  id={patId}
                  type="password"
                  autoComplete="off"
                  value={patInput}
                  onChange={(event) => setPatInput(event.target.value)}
                  placeholder="glpat-…"
                  disabled={pending}
                />
                <FieldDescription>
                  Used for imports and syncs from this host. Use read_repository scope.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <PlusIcon data-icon="inline-start" />
                )}
                {pending ? "Saving…" : "Save credential"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
