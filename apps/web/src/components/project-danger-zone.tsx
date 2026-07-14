import { AlertTriangleIcon } from "lucide-react";
import { DeleteProjectAction } from "@/components/delete-project-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function ProjectDangerZone({
  project,
}: {
  project: { id: string; name: string; deletionStatus: "deleting" | "failed" | null; deletionError: string | null };
}) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>Permanently delete this project and every platform-managed resource it owns.</CardDescription>
      </CardHeader>
      <CardContent>
        {project.deletionStatus === "failed" ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Previous deletion attempt failed</AlertTitle>
            <AlertDescription>
              {project.deletionError ?? "The project record remains. Some runtime resources may already be removed; retry deletion."}
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            Running deployments are stopped first. Source snapshots, releases, sessions, usage, routes, secrets, logs,
            observer data, and sandbox workspaces are then removed permanently.
          </p>
        )}
      </CardContent>
      <CardFooter>
        <DeleteProjectAction
          projectId={project.id}
          projectName={project.name}
          deletionStatus={project.deletionStatus}
        />
      </CardFooter>
    </Card>
  );
}
