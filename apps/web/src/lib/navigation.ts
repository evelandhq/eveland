import {
  ActivityIcon,
  BracesIcon,
  ChartNoAxesColumnIcon,
  FileKeyIcon,
  FileTextIcon,
  FolderIcon,
  HistoryIcon,
  PlayIcon,
  RocketIcon,
  ScrollTextIcon,
} from "lucide-react"

export const globalNavigationItems = [
  { href: "/projects", label: "Projects", icon: FolderIcon },
  { href: "/deployments", label: "Deployments", icon: RocketIcon },
  { href: "/usage", label: "Usage", icon: ChartNoAxesColumnIcon },
] as const

export function getProjectNavigationItems(projectId: string) {
  const projectHref = `/projects/${projectId}`

  return [
    { href: projectHref, label: "Overview", icon: ActivityIcon },
    { href: `${projectHref}/playground`, label: "Playground", icon: PlayIcon },
    { href: `${projectHref}/sessions`, label: "Sessions", icon: HistoryIcon },
    { href: `${projectHref}/usage`, label: "Usage", icon: ChartNoAxesColumnIcon },
    { href: `${projectHref}/schedules`, label: "Schedules", icon: ScrollTextIcon },
    { href: `${projectHref}/source`, label: "Source", icon: BracesIcon },
    { href: `${projectHref}/secrets`, label: "Secrets", icon: FileKeyIcon },
    { href: `${projectHref}/logs`, label: "Logs", icon: FileTextIcon },
  ] as const
}

export function getProjectIdFromPathname(pathname: string): string | null {
  const [, root, projectId] = pathname.split("/")

  return root === "projects" && projectId && projectId !== "new" ? projectId : null
}

export function isNavigationItemActive(pathname: string, href: string): boolean {
  const segments = href.split("/").filter(Boolean)
  const isProjectOverview = segments[0] === "projects" && segments.length === 2

  return pathname === href || (!isProjectOverview && pathname.startsWith(`${href}/`))
}
