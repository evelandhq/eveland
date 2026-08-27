"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2Icon } from "lucide-react";
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
  deleteModelGatewayProvider,
  listModelGatewayProviders,
  listModelGatewayRegistryEvents,
  saveModelGatewayProvider,
  type ModelGatewayProvider,
  type ModelGatewayRegistryEvent,
} from "@/lib/model-gateway-api";

const emptyDraft = { providerId: "", name: "", baseUrl: "", apiKey: "" };

export function ModelGatewayProviders() {
  const [providers, setProviders] = useState<ModelGatewayProvider[]>([]);
  const [events, setEvents] = useState<ModelGatewayRegistryEvent[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [nextProviders, nextEvents] = await Promise.all([
      listModelGatewayProviders(),
      listModelGatewayRegistryEvents(),
    ]);
    setProviders(nextProviders);
    setEvents(nextEvents);
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await saveModelGatewayProvider({
        providerId: draft.providerId.trim(),
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
      });
      setDraft(emptyDraft);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saving the provider failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected providers</CardTitle>
          <CardDescription>
            The stored credential is write-only: rotate it by saving the provider again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No providers connected yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => (
                  <TableRow key={provider.id}>
                    <TableCell>
                      <div className="font-medium">{provider.name}</div>
                      <code className="text-xs text-muted-foreground">{provider.providerId}</code>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">{provider.baseUrl}</code>
                    </TableCell>
                    <TableCell>
                      <DateTime value={provider.updatedAt} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        aria-label={`Remove ${provider.providerId}`}
                        onClick={() =>
                          void deleteModelGatewayProvider(provider.providerId).then(reload)
                        }
                        size="icon"
                        variant="ghost"
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connect a provider</CardTitle>
          <CardDescription>
            The key is verified against the endpoint before anything is saved — a rejected
            credential is never stored.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void save(event)}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mg-provider-slug">Provider id</Label>
              <Input
                id="mg-provider-slug"
                onChange={(event) => setDraft({ ...draft, providerId: event.target.value })}
                placeholder="zai"
                required
                value={draft.providerId}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mg-provider-name">Display name</Label>
              <Input
                id="mg-provider-name"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Z.ai"
                required
                value={draft.name}
              />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="mg-provider-url">OpenAI-compatible base URL</Label>
              <Input
                id="mg-provider-url"
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                placeholder="https://api.z.ai/api/paas/v4"
                required
                type="url"
                value={draft.baseUrl}
              />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="mg-provider-key">API key</Label>
              <Input
                autoComplete="off"
                id="mg-provider-key"
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                placeholder="sk-..."
                required
                type="password"
                value={draft.apiKey}
              />
            </div>
            {error ? <p className="text-sm text-destructive sm:col-span-2">{error}</p> : null}
            <div className="sm:col-span-2">
              <Button disabled={saving} type="submit">
                {saving ? "Verifying…" : "Verify & save"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Registry changes</CardTitle>
          <CardDescription>Append-only audit trail; never contains credentials.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {events.map((event) => (
                <li className="flex items-baseline justify-between gap-3" key={event.id}>
                  <span>
                    <code className="text-xs">{event.kind}</code>{" "}
                    <span className="text-muted-foreground">{event.subject}</span>
                  </span>
                  <DateTime
                    className="shrink-0 text-xs text-muted-foreground"
                    value={event.createdAt}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
