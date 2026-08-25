"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlayIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { getProjectNavigationItems } from "@/lib/navigation";

/**
 * The heading block for everything under a project, living in the layout rather
 * than being re-declared by each page — eight stacked title blocks is what this
 * replaced.
 *
 * Overview is the project's front page, so there the project name IS the title
 * and its description sits under it. A description describes the project, so it
 * can only ever hang off the project's name; under a section title like
 * "Sessions" it would be answering a question nobody asked. Everywhere else the
 * project is context and the section is the title.
 */
export function ProjectBreadcrumb({
  projectDescription,
  projectId,
  projectName,
  status,
}: {
  projectDescription: string | null;
  projectId: string;
  projectName: string;
  /**
   * Deployment status, shown on Overview only. Repeating it on all eight
   * sub-pages made a filled pill shout the same unchanging sentence from the
   * corner of every screen; the project's front page is where it belongs.
   */
  status?: React.ReactNode;
}) {
  const pathname = usePathname();
  const overviewHref = `/projects/${projectId}`;
  const items = getProjectNavigationItems(projectId);
  // Longest match wins: every section href extends the overview's, so a plain
  // startsWith would always report "Overview".
  const current = [...items]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  if (!current || current.href === overviewHref) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="truncate text-[17px] font-semibold tracking-tight">{projectName}</h1>
            {status ? <div className="flex shrink-0 items-center gap-1.5">{status}</div> : null}
          </div>
          {projectDescription ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">{projectDescription}</p>
          ) : null}
        </div>
        <Link
          href={`/projects/${projectId}/playground`}
          className={buttonVariants({ variant: "outline", size: "sm", className: "shrink-0" })}
        >
          <PlayIcon aria-hidden="true" data-icon="inline-start" />
          Open playground
        </Link>
      </div>
    );
  }

  return (
    // One row: the path reads left to right at title weight, with the project
    // muted so the section still lands as the heading.
    <div className="flex min-w-0 items-baseline gap-2 text-[17px] tracking-tight">
      <Link
        className="min-w-0 shrink truncate font-normal text-muted-foreground hover:text-foreground"
        href={overviewHref}
      >
        {projectName}
      </Link>
      <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
        /
      </span>
      <h1 className="shrink-0 truncate font-semibold">{current.label}</h1>
    </div>
  );
}
