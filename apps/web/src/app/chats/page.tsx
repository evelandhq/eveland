import Link from "next/link";
import { MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { getChats, getProjects } from "@/lib/api";
import { NewChatForm } from "@/components/new-chat-form";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function ChatsPage() {
  const [chats, projects] = await Promise.all([getChats(), getProjects()]);
  const deployedProjects = projects.filter((project) => project.deploymentStatus === "running");

  return (
    <main className="min-h-screen bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <div className="flex items-baseline gap-3">
          <Link href="/projects" className="text-base font-semibold">
            Eveland
          </Link>
          <span className="text-xs text-muted-foreground">agent chats</span>
        </div>
        <Link href="/projects/new" className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted">
          <PlusIcon data-icon="inline-start" />
          New project
        </Link>
      </header>

      <section className="mx-auto grid w-full max-w-6xl gap-5 px-6 py-6 lg:grid-cols-[1fr_24rem]">
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="text-xl font-semibold tracking-normal">Chats</h1>
            <p className="mt-1 text-sm text-muted-foreground">Your conversations with deployed agents. Each chat stays bound to one agent.</p>
          </div>

          <div className="overflow-hidden rounded-md border border-border bg-card">
            {chats.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
                <MessageSquarePlusIcon className="h-8 w-8 text-muted-foreground" />
                <h2 className="mt-3 text-sm font-semibold">No chats yet</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">Choose a running agent and send the first message to create a chat.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {chats.map((chat) => (
                  <Link key={chat.id} href={`/chats/${chat.id}`} className="block px-4 py-3 hover:bg-muted/40">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="font-medium">{chat.title}</h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {chat.projectName} {chat.projectDeleted ? "· agent deleted" : ""}
                        </p>
                        {chat.latestMessage ? <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{chat.latestMessage}</p> : null}
                      </div>
                      <time className="shrink-0 text-xs text-muted-foreground">{new Date(chat.updatedAt).toLocaleString()}</time>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold">Start a new chat</h2>
            <p className="mt-1 text-xs text-muted-foreground">Select one deployed agent and send the first message.</p>
          </div>
          {deployedProjects.length === 0 ? (
            <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">No running agents are available yet.</div>
          ) : (
            deployedProjects.map((project) => (
              <div key={project.id} className="rounded-md border border-border bg-card p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">{project.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{project.gitUrl ?? project.importKind.toUpperCase()}</p>
                  </div>
                  <StatusBadge status={project.deploymentStatus} />
                </div>
                <NewChatForm projectId={project.id} projectName={project.name} compact />
              </div>
            ))
          )}
        </aside>
      </section>
    </main>
  );
}
