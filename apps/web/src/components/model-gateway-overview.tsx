"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  listModelGatewayApiKeys,
  listModelGatewayModels,
  type ModelGatewayModelRoute,
} from "@/lib/model-gateway-api";

export function ModelGatewayOverview() {
  const [models, setModels] = useState<ModelGatewayModelRoute[] | null>(null);
  const [keyCount, setKeyCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listModelGatewayModels()
      .then((routes) => {
        if (!cancelled) setModels(routes);
      })
      .catch(() => undefined);
    void listModelGatewayApiKeys()
      .then((keys) => {
        if (!cancelled) setKeyCount(keys.filter((key) => key.revokedAt === null).length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const providerCount = models === null ? null : new Set(models.map((m) => m.providerId)).size;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Routed models</CardDescription>
          <CardTitle className="text-3xl tabular-nums">{models?.length ?? "—"}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Canonical ids Agents can use today.
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Connected providers</CardDescription>
          <CardTitle className="text-3xl tabular-nums">{providerCount ?? "—"}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          BYOK connections serving those models.
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Your active API keys</CardDescription>
          <CardTitle className="text-3xl tabular-nums">{keyCount ?? "—"}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Personal keys for callers outside a Deployment.
        </CardContent>
      </Card>
    </div>
  );
}
