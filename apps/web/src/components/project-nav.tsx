import Link from "next/link";
import { ActivityIcon, BracesIcon, FileKeyIcon, FileTextIcon, HistoryIcon, PlayIcon, ScrollTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "", label: "Overview", icon: ActivityIcon },
  { href: "/playground", label: "Playground", icon: PlayIcon },
  { href: "/sessions", label: "Sessions", icon: HistoryIcon },
  { href: "/schedules", label: "Schedules", icon: ScrollTextIcon },
  { href: "/source", label: "Source", icon: BracesIcon },
  { href: "/secrets", label: "Secrets", icon: FileKeyIcon },
  { href: "/logs", label: "Logs", icon: FileTextIcon },
];

export function ProjectNav({ projectId }: { projectId: string }) {
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-border px-5 py-2">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.href || "overview"}
            href={`/projects/${projectId}${item.href}`}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon data-icon="inline-start" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
