"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon, Trash2Icon } from "lucide-react";
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
import { getCurrentMember } from "@/lib/client-api";
import {
  deleteModelGatewayModelRoute,
  listModelGatewayModels,
  upsertModelGatewayModelRoute,
  type ModelGatewayModelRoute,
} from "@/lib/model-gateway-api";

export function ModelGatewayModels() {
  const [models, setModels] = useState<ModelGatewayModelRoute[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    modelId: "",
    providerId: "",
    providerModelId: "",
    displayName: "",
  });

  const reload = useCallback(async () => {
    setModels(await listModelGatewayModels());
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload().catch(() => setLoaded(true));
    void getCurrentMember()
      .then((member) => setIsAdmin(member.role === "admin"))
      .catch(() => undefined);
  }, [reload]);

  async function copyModelId(modelId: string) {
    await navigator.clipboard.writeText(modelId).catch(() => undefined);
    setCopied(modelId);
    setTimeout(() => setCopied((current) => (current === modelId ? null : current)), 1500);
  }

  async function addRoute(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await upsertModelGatewayModelRoute({
        modelId: draft.modelId.trim(),
        providerId: draft.providerId.trim(),
        providerModelId: draft.providerModelId.trim(),
        ...(draft.displayName.trim() === "" ? {} : { displayName: draft.displayName.trim() }),
      });
      setDraft({ modelId: "", providerId: "", providerModelId: "", displayName: "" });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saving the route failed.");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Available models</CardTitle>
          <CardDescription>
            A model is available exactly when an administrator connected its provider and routed it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loaded && models.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No models routed yet{isAdmin ? " — add one below." : " — ask an administrator."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Provider model id</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((model) => (
                  <TableRow key={model.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="text-xs">{model.modelId}</code>
                        <Button
                          aria-label={`Copy ${model.modelId}`}
                          onClick={() => void copyModelId(model.modelId)}
                          size="icon"
                          variant="ghost"
                        >
                          {copied === model.modelId ? (
                            <CheckIcon className="size-3.5" />
                          ) : (
                            <CopyIcon className="size-3.5" />
                          )}
                        </Button>
                      </div>
                      {model.displayName ? (
                        <div className="text-xs text-muted-foreground">{model.displayName}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>{model.providerId}</TableCell>
                    <TableCell>
                      <code className="text-xs">{model.providerModelId}</code>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">Available</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {isAdmin ? (
                        <Button
                          aria-label={`Remove ${model.modelId}`}
                          onClick={() =>
                            void deleteModelGatewayModelRoute(model.modelId).then(reload)
                          }
                          size="icon"
                          variant="ghost"
                        >
                          <Trash2Icon className="size-3.5" />
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

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a model route</CardTitle>
            <CardDescription>
              Point a canonical model id at a connected provider&apos;s own model id.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void addRoute(event)}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mg-model-id">Model id</Label>
                <Input
                  id="mg-model-id"
                  onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
                  placeholder="zai/glm-5.3-flash"
                  required
                  value={draft.modelId}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mg-provider-id">Provider</Label>
                <Input
                  id="mg-provider-id"
                  onChange={(event) => setDraft({ ...draft, providerId: event.target.value })}
                  placeholder="zai"
                  required
                  value={draft.providerId}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mg-provider-model-id">Provider model id</Label>
                <Input
                  id="mg-provider-model-id"
                  onChange={(event) => setDraft({ ...draft, providerModelId: event.target.value })}
                  placeholder="glm-5.3-flash"
                  required
                  value={draft.providerModelId}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mg-display-name">Display name (optional)</Label>
                <Input
                  id="mg-display-name"
                  onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
                  placeholder="GLM 5.3 Flash"
                  value={draft.displayName}
                />
              </div>
              {error ? <p className="text-sm text-destructive sm:col-span-2">{error}</p> : null}
              <div className="sm:col-span-2">
                <Button type="submit">Save route</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
