"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertCircleIcon, KeyRoundIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { agentAuthCallbackSearch, safeAgentAuthReturnPath } from "@/lib/agent-auth-callback";
import { completeAgentAuthCallback } from "@/lib/client-api";

export default function AgentAuthCallbackPage() {
  const params = useParams<{ method: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const search = agentAuthCallbackSearch(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    if (!search) {
      setError("The identity provider response is missing its state parameter.");
      return;
    }
    completeAgentAuthCallback(params.method, search)
      .then(({ returnPath }) => router.replace(safeAgentAuthReturnPath(returnPath)))
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Agent authorization could not be completed.");
      });
  }, [params.method, router]);

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-5 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <KeyRoundIcon />
          </div>
          <CardTitle>Agent authorization</CardTitle>
          <CardDescription>
            Completing the Route Auth grant for this Agent Connection. Tokens stay on the server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex flex-col gap-4">
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>Authorization failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
              <Button variant="outline" onClick={() => router.replace("/projects")}>
                Back to projects
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Finishing authorization…
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
