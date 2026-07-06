"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, RocketIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enqueueBuildDeploy } from "@/lib/api";

export function DeploymentActions({ projectId, canDeploy }: { projectId: string; canDeploy: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deployLatest() {
    setPending(true);
    setError(null);

    try {
      await enqueueBuildDeploy(projectId);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Deploy request failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" onClick={deployLatest} disabled={!canDeploy || pending}>
        {pending ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <RocketIcon data-icon="inline-start" />}
        Deploy latest
      </Button>
      {error ? <p className="max-w-72 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
