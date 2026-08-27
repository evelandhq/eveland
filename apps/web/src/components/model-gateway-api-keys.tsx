"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DateTime } from "@/components/date-time";
import {
  listModelGatewayApiKeys,
  mintModelGatewayApiKey,
  revokeModelGatewayApiKey,
  type ModelGatewayApiKey,
} from "@/lib/model-gateway-api";

export function ModelGatewayApiKeys() {
  const [keys, setKeys] = useState<ModelGatewayApiKey[]>([]);
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<{ token: string; name: string } | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setKeys(await listModelGatewayApiKeys());
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  async function mint(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await mintModelGatewayApiKey(name.trim());
      setMinted({ token: result.token, name: result.key.name });
      setCopiedToken(false);
      setName("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Minting the key failed.");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create a key</CardTitle>
          <CardDescription>
            The key is shown exactly once. Use it as <code>AI_GATEWAY_API_KEY</code> for any caller
            that can reach this instance&apos;s Model Gateway.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void mint(event)}>
            <div className="flex min-w-56 flex-col gap-1.5">
              <Label htmlFor="mg-key-name">Name</Label>
              <Input
                id="mg-key-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="local eve dev"
                required
                value={name}
              />
            </div>
            <Button type="submit">Create key</Button>
          </form>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {minted ? (
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-sm font-medium">&ldquo;{minted.name}&rdquo; created</p>
              <p className="mb-2 text-xs text-muted-foreground">
                Copy it now — it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="break-all text-xs">{minted.token}</code>
                <Button
                  aria-label="Copy API key"
                  onClick={() => {
                    void navigator.clipboard.writeText(minted.token).catch(() => undefined);
                    setCopiedToken(true);
                  }}
                  size="icon"
                  variant="ghost"
                >
                  {copiedToken ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your keys</CardTitle>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No keys yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>{key.name}</TableCell>
                    <TableCell>
                      <DateTime value={key.createdAt} />
                    </TableCell>
                    <TableCell>
                      {key.revokedAt === null ? (
                        <Badge variant="secondary">Active</Badge>
                      ) : (
                        <Badge variant="outline">Revoked</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {key.revokedAt === null ? (
                        <Button
                          onClick={() => void revokeModelGatewayApiKey(key.id).then(reload)}
                          size="sm"
                          variant="outline"
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
