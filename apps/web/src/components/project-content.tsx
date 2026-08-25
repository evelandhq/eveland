"use client";

import { usePathname } from "next/navigation";
import { PageContainer } from "@/components/page-container";
import { ProjectDeletionNotice } from "@/components/project-deletion-notice";
import { ProjectDeletionPoller } from "@/components/project-deletion-poller";

export function ProjectContent({
  children,
  deletionError,
  deletionStatus,
}: {
  children: React.ReactNode;
  deletionError: string | null;
  deletionStatus: "deleting" | "failed" | null;
}) {
  const pathname = usePathname();

  return (
    <>
      <ProjectDeletionPoller active={deletionStatus === "deleting"} />
      {pathname.endsWith("/source") ? (
        <div className="flex h-[calc(100svh-3rem-1px)] min-h-0 min-w-0 flex-none flex-col overflow-hidden md:h-svh">
          <ProjectDeletionNotice status={deletionStatus} error={deletionError} />
          <fieldset
            disabled={deletionStatus === "deleting"}
            className="m-0 flex min-h-0 min-w-0 flex-1 border-0 p-0"
          >
            {children}
          </fieldset>
        </div>
      ) : (
        <div className="min-h-[calc(100svh-3rem)] bg-background">
          <PageContainer className="gap-4">
            <ProjectDeletionNotice status={deletionStatus} error={deletionError} />
            <fieldset disabled={deletionStatus === "deleting"} className="contents">
              {children}
            </fieldset>
          </PageContainer>
        </div>
      )}
    </>
  );
}
