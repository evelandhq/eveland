"use client";

import { useState } from "react";
import { LoaderCircleIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { sendChatMessage, type Chat, type ChatMessage } from "@/lib/api";

type ChatPanelProps = {
  initialChat: Chat;
  initialMessages: ChatMessage[];
};

export function ChatPanel({ initialChat, initialMessages }: ChatPanelProps) {
  const [chat, setChat] = useState(initialChat);
  const [messages, setMessages] = useState(initialMessages);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const isReadOnly = chat.projectDeleted || chat.status === "agent_deleted";

  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isReadOnly || isPending) {
      return;
    }

    setIsPending(true);
    setError(null);
    try {
      const result = await sendChatMessage(chat.id, trimmed);
      setChat(result.chat);
      setMessages(result.messages);
      setMessage("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="grid min-h-[calc(100vh-8rem)] gap-4 lg:grid-cols-[1fr_20rem]">
      <section className="flex flex-col rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h1 className="text-base font-semibold">{chat.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Bound to {chat.projectName}{chat.projectDeleted ? " · agent deleted" : ""}
          </p>
        </div>

        {isReadOnly ? (
          <div className="border-b border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
            This agent has been deleted. You can still view this chat history, but you can no longer continue the conversation.
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-4">
          {messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No messages yet.</div>
          ) : (
            messages.map((item) => <ChatBubble key={item.id} message={item} />)
          )}
        </div>

        <form className="border-t border-border p-3" onSubmit={submitMessage}>
          <FieldGroup>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="chat-message" className="sr-only">
                Message
              </FieldLabel>
              <div className="flex items-end gap-2">
                <Textarea
                  id="chat-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={isReadOnly || isPending}
                  aria-invalid={Boolean(error)}
                  className="min-h-20 flex-1"
                  placeholder={isReadOnly ? "This agent has been deleted" : `Message ${chat.projectName}...`}
                />
                <Button type="submit" disabled={isReadOnly || isPending || message.trim().length === 0}>
                  {isPending ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
                  Send
                </Button>
              </div>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          </FieldGroup>
        </form>
      </section>

      <aside className="rounded-md border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Chat details</h2>
        <dl className="mt-4 flex flex-col gap-3 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="truncate text-right">{chat.projectName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">State</dt>
            <dd>{isReadOnly ? "read-only" : isPending ? "running" : "active"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Messages</dt>
            <dd>{messages.length}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Updated</dt>
            <dd className="text-right">{new Date(chat.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={isUser ? "ml-auto max-w-[80%] rounded-md bg-primary px-4 py-3 text-primary-foreground" : "mr-auto max-w-[80%] rounded-md border border-border bg-background px-4 py-3"}>
      <div className="text-xs font-semibold uppercase tracking-normal opacity-70">{message.role}</div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
    </article>
  );
}
