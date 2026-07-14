"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function SecretForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    const response = await fetch(`${apiBaseUrl}/projects/${projectId}/secrets`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });

    setPending(false);

    if (!response.ok) {
      setError("Secret could not be saved.");
      return;
    }

    const result = (await response.json()) as { jobs: unknown[] };
    setKey("");
    setValue("");
    setNotice(
      result.jobs.length > 0
        ? "Secret saved. Restarting live deployments so the new value takes effect."
        : "Secret saved. It will be used by the next deployment.",
    );
    router.refresh();
  }

  return (
    <form className="flex flex-col gap-3 rounded-md border border-border bg-card p-4" onSubmit={submit}>
      <h3 className="text-sm font-semibold">Add secret</h3>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Variable
        <input value={key} onChange={(event) => setKey(event.target.value)} className="h-8 rounded-sm border border-input bg-background px-2 text-sm" placeholder="OPENAI_API_KEY" />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Value
        <input value={value} onChange={(event) => setValue(event.target.value)} type="password" className="h-8 rounded-sm border border-input bg-background px-2 text-sm" />
      </label>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving..." : "Save secret"}
      </Button>
    </form>
  );
}
