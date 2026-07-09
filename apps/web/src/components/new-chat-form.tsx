"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircleIcon, MessageSquarePlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { createChat } from "@/lib/api";

type NewChatFormProps = {
  projectId: string;
  projectName: string;
  disabled?: boolean;
  compact?: boolean;
};

export function NewChatForm({ projectId, projectName, disabled = false, compact = false }: NewChatFormProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function submitChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || disabled || isPending) {
      return;
    }

    setIsPending(true);
    setError(null);
    try {
      const result = await createChat(projectId, trimmed);
      router.push(`/chats/${result.chat.id}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form className={compact ? "flex items-start gap-2" : "rounded-md border border-border bg-card p-4"} onSubmit={submitChat}>
      <FieldGroup className={compact ? "flex-1" : undefined}>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor={`new-chat-${projectId}`} className={compact ? "sr-only" : undefined}>
            First message to {projectName}
          </FieldLabel>
          <div className={compact ? "flex items-start gap-2" : "mt-2 flex items-end gap-2"}>
            <Textarea
              id={`new-chat-${projectId}`}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={disabled || isPending}
              aria-invalid={Boolean(error)}
              className={compact ? "min-h-10 flex-1" : "min-h-20 flex-1"}
              placeholder={disabled ? "Deploy this agent before chatting" : "Start with your first message..."}
            />
            <Button type="submit" disabled={disabled || isPending || message.trim().length === 0}>
              {isPending ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <MessageSquarePlusIcon data-icon="inline-start" />}
              New Chat
            </Button>
          </div>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
      </FieldGroup>
    </form>
  );
}
