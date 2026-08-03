import Link from "next/link";
import { ArrowLeftIcon, SproutIcon } from "lucide-react";
import { NewProjectFlow } from "@/components/new-project-flow";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "New project",
};

export default function NewProjectPage() {
  return (
    <div className="min-h-svh bg-background">
      <header className="grid h-16 grid-cols-[1fr_auto_1fr] items-center border-b px-4 sm:px-6">
        <Link href="/projects" className={cn(buttonVariants({ variant: "ghost" }), "w-fit")}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Link>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <SproutIcon className="size-4" />
          New project
        </div>
        <div aria-hidden="true" />
      </header>
      <main className="min-h-[calc(100svh-4rem)]">
        <NewProjectFlow />
      </main>
    </div>
  );
}
