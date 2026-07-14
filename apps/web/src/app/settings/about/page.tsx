import { Fragment } from "react"
import { ShieldCheckIcon, TriangleAlertIcon } from "lucide-react"
import { isSameBuild } from "@eveland/core/build-info"
import { createConfigurationSnapshot } from "@eveland/core/config-diagnostics"
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
import { getApiBuildInfo, getCurrentMember, getSystemConfigurationDiagnostics } from "@/lib/server-api"

export const dynamic = "force-dynamic"

export default async function AboutSettingsPage() {
  const webBuild = createBuildInfoFromEnv("web", process.env)
  const [apiBuild, currentMember] = await Promise.all([
    getApiBuildInfo().catch(() => null),
    getCurrentMember(),
  ])
  const hasMismatch = apiBuild ? !isSameBuild(webBuild, apiBuild) : false
  const systemConfiguration =
    currentMember.role === "admin" ? await getSystemConfigurationDiagnostics().catch(() => null) : null
  const configurationComponents =
    currentMember.role === "admin"
      ? [createConfigurationSnapshot("web", process.env), ...(systemConfiguration?.components ?? [])]
      : []
  const configurationIssues = configurationComponents.flatMap((component) => component.entries).filter((entry) => entry.status !== "ok")
  const missingConfiguration = configurationIssues.filter((entry) => entry.status === "missing").length
  const warningConfiguration = configurationIssues.length - missingConfiguration

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">About</h2>
        <p className="text-sm text-muted-foreground">Identify the Eveland release and effective runtime configuration.</p>
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

      {currentMember.role !== "admin" ? (
        <Alert>
          <ShieldCheckIcon />
          <AlertTitle>Administrator access required</AlertTitle>
          <AlertDescription>Runtime configuration is available only to Team administrators.</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Runtime configuration</CardTitle>
            <CardDescription>Effective values, their source, and the purpose of each supported environment variable.</CardDescription>
            <CardAction><Badge variant="outline">Admin only</Badge></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Alert>
              <ShieldCheckIcon />
              <AlertTitle>Sensitive values are masked</AlertTitle>
              <AlertDescription>Secrets are never returned. Credentials and query values are removed from connection URLs.</AlertDescription>
            </Alert>

            {!systemConfiguration ? (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>System configuration unavailable</AlertTitle>
                <AlertDescription>The Web configuration is shown, but API diagnostics could not be loaded.</AlertDescription>
              </Alert>
            ) : null}

            {configurationIssues.length > 0 ? (
              <Alert variant={missingConfiguration > 0 ? "destructive" : "default"}>
                <TriangleAlertIcon />
                <AlertTitle>Configuration attention required</AlertTitle>
                <AlertDescription>
                  {missingConfiguration} missing and {warningConfiguration} warning configuration values were found.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Variable</TableHead>
                    <TableHead>Component</TableHead>
                    <TableHead>Effective value</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Purpose</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {configurationComponents.map((component) => (
                    <Fragment key={component.component}>
                      <TableRow>
                        <TableCell colSpan={5}>
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary">{component.component}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {component.observedAt ? `Observed ${new Date(component.observedAt).toLocaleString()}` : "Unavailable"}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                      {"unavailableReason" in component ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-muted-foreground">{component.unavailableReason}</TableCell>
                        </TableRow>
                      ) : component.entries.map((entry) => (
                        <TableRow key={`${component.component}-${entry.name}`}>
                          <TableCell><code className="font-mono text-xs">{entry.name}</code></TableCell>
                          <TableCell><Badge variant="outline">{component.component}</Badge></TableCell>
                          <TableCell>
                            <div className="flex min-w-44 flex-col items-start gap-1">
                              <code className="break-all font-mono text-xs">{entry.value}</code>
                              {entry.status !== "ok" ? (
                                <Badge variant={entry.status === "missing" ? "destructive" : "secondary"}>{entry.status}</Badge>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{entry.source.replace("_", " ")}</Badge>
                          </TableCell>
                          <TableCell className="min-w-64 text-muted-foreground">{entry.purpose}</TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
          <Separator />
          <CardFooter className="text-muted-foreground">
            Values are read-only. Restart the affected component after changing its environment.
          </CardFooter>
        </Card>
      )}
    </div>
  )
}
