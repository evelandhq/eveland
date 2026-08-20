import { PageContainer } from "@/components/page-container";
import { UsageExplorer } from "@/components/usage/usage-explorer";
import { getProjects, getUsageAnalytics } from "@/lib/server-api";
import { parseUsageFilters } from "@/lib/usage";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Usage",
};

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseUsageFilters(await searchParams);
  const [analytics, projects] = await Promise.all([getUsageAnalytics(filters), getProjects()]);

  return (
    <PageContainer>
      <UsageExplorer analytics={analytics} projects={projects} scope={{ type: "workspace" }} />
    </PageContainer>
  );
}
