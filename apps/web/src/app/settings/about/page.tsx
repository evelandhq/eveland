import { TriangleAlertIcon } from "lucide-react"
import { isSameBuild } from "@eveland/core/build-info"
import { createBuildInfoFromEnv } from "@eveland/core/server/build-info"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Separator } from "@/components/ui/separator"
import { getApiBuildInfo } from "@/lib/server-api"

export const dynamic = "force-dynamic"

export default async function AboutSettingsPage() {
  const webBuild = createBuildInfoFromEnv("web", process.env)
  const apiBuild = await getApiBuildInfo().catch(() => null)
  const hasMismatch = apiBuild ? !isSameBuild(webBuild, apiBuild) : false

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">About</h2>
        <p className="text-sm text-muted-foreground">Identify the Eveland release running this workspace.</p>
      </header>

      {hasMismatch ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Component version mismatch</AlertTitle>
          <AlertDescription>Web and API were not deployed from the same build. Finish upgrading the instance before testing.</AlertDescription>
        </Alert>
      ) : null}

      {!apiBuild ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>API build information unavailable</AlertTitle>
          <AlertDescription>The Web build is shown below, but the API health endpoint could not be reached.</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Eveland</CardTitle>
          <CardDescription>Self-hosted eve runtime control plane</CardDescription>
          <CardAction><Badge variant="secondary">{webBuild.channel}</Badge></CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-semibold tracking-tight">v{webBuild.version}</p>
        </CardContent>
        <Separator />
        <CardFooter className="gap-2">
          <span className="text-muted-foreground">Revision</span>
          <code className="font-mono">{webBuild.revision}</code>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Components</CardTitle>
          <CardDescription>Compare the build identity reported by each visible part of this instance.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Component</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Revision</TableHead>
                <TableHead>Channel</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[webBuild, ...(apiBuild ? [apiBuild] : [])].map((build) => (
                <TableRow key={build.component}>
                  <TableCell className="font-medium">{build.component}</TableCell>
                  <TableCell>v{build.version}</TableCell>
                  <TableCell><code className="font-mono">{build.revision}</code></TableCell>
                  <TableCell><Badge variant="outline">{build.channel}</Badge></TableCell>
                </TableRow>
              ))}
              {!apiBuild ? (
                <TableRow>
                  <TableCell className="font-medium">api</TableCell>
                  <TableCell colSpan={3} className="text-muted-foreground">Unavailable</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
        <Separator />
        <CardFooter className="gap-2">
          <span className="text-muted-foreground">Service identity:</span>
          <code className="font-mono">eveland</code>
        </CardFooter>
      </Card>
    </div>
  )
}
