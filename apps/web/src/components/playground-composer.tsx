"use client";

// Composer pieces both Playground clients (v26 and v27) share.

import type { FileUIPart } from "ai";
import { BrainIcon, PlusIcon, SquareIcon } from "lucide-react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInputButton,
  PromptInputHeader,
  PromptInputSubmit,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { PLAYGROUND_MAX_TOTAL_FILE_BYTES } from "@evelandhq/core/eve";

export function ComposerAction({
  disabled,
  hasInputText,
  isBusy,
  onCancel,
}: {
  readonly disabled: boolean;
  readonly hasInputText: boolean;
  readonly isBusy: boolean;
  readonly onCancel: () => void;
}) {
  const attachments = usePromptInputAttachments();
  const canSubmit = hasInputText || attachments.files.length > 0;

  if (!isBusy || canSubmit) {
    return <PromptInputSubmit disabled={disabled} />;
  }

  return (
    <PromptInputButton aria-label="Stop" disabled={disabled} onClick={onCancel} variant="outline">
      <SquareIcon className="size-3 fill-current" />
    </PromptInputButton>
  );
}

export function PendingThinking() {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <div className="mb-4 flex w-full items-center gap-2 text-muted-foreground text-sm">
          <BrainIcon className="size-4" />
          <Shimmer duration={1}>Thinking</Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}

export function ComposerAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <PromptInputHeader>
      <Attachments variant="inline">
        {attachments.files.map((file) => (
          <Attachment data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

export function ComposerAttachmentButton({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton
      aria-label="Add attachments"
      disabled={disabled}
      onClick={attachments.openFileDialog}
      title="Add attachments"
      tooltip="Add attachments · Up to 4 files, 10 MiB total"
    >
      <PlusIcon />
    </PromptInputButton>
  );
}

export function assertAttachmentTotal(files: readonly FileUIPart[]): void {
  const totalBytes = files.reduce((total, file) => total + dataUrlSize(file.url), 0);
  if (totalBytes > PLAYGROUND_MAX_TOTAL_FILE_BYTES) {
    throw new Error("Attachments exceed the 10 MiB total limit.");
  }
}

function dataUrlSize(url: string): number {
  const comma = url.indexOf(",");
  if (comma === -1) {
    return 0;
  }
  const payload = url.slice(comma + 1);
  return url.slice(0, comma).endsWith(";base64")
    ? Math.max(
        0,
        Math.floor((payload.length * 3) / 4) -
          (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0),
      )
    : new TextEncoder().encode(decodeURIComponent(payload)).length;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
