"use client";

import { useState } from "react";
import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import type { PublicGitCredential } from "@eveland/core/contracts";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { deleteGitCredential } from "@/lib/client-api";

export function GitCredentialsSettings({
  initialCredentials,
}: {
  initialCredentials: PublicGitCredential[];
}) {
  const [credentials, setCredentials] = useState(initialCredentials);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <Card>
      <CardHeader>
        <CardTitle>Saved hosts</CardTitle>
        <CardDescription>
          PATs are encrypted and scoped to your account. A new or replacement PAT is saved only
          after a successful import.
        </CardDescription>
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
                Enter a GitLab PAT while importing a private repository to add one.
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
  );
}
