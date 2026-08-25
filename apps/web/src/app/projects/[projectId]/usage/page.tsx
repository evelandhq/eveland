import { UsageExplorer } from "@/components/usage/usage-explorer";
import { getProjects, getProjectUsageAnalytics } from "@/lib/server-api";
import { parseUsageFilters } from "@/lib/usage";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Usage",
};

export default async function ProjectUsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const filters = parseUsageFilters(await searchParams);
  const [analytics, projects] = await Promise.all([
    getProjectUsageAnalytics(projectId, filters),
    getProjects(),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <UsageExplorer
        analytics={analytics}
        projects={projects}
        scope={{ type: "project", projectId }}
      />
    </div>
  );
}
