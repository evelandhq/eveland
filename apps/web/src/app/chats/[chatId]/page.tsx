import Link from "next/link";
import { notFound } from "next/navigation";
import { getChat } from "@/lib/api";
import { ChatPanel } from "@/components/chat-panel";

export const dynamic = "force-dynamic";

type ChatPageProps = {
  params: Promise<{ chatId: string }>;
};

export default async function ChatPage({ params }: ChatPageProps) {
  const { chatId } = await params;
  const result = await getChat(chatId);

  if (!result) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <div className="flex items-baseline gap-3">
          <Link href="/projects" className="text-base font-semibold">
            Eveland
          </Link>
          <span className="text-xs text-muted-foreground">/ chats</span>
        </div>
        <Link href="/chats" className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          Chat history
        </Link>
      </header>

      <section className="mx-auto w-full max-w-6xl px-6 py-6">
        <ChatPanel initialChat={result.chat} initialMessages={result.messages} />
      </section>
    </main>
  );
}
