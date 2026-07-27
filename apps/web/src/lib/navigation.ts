import {
  ActivityIcon,
  BoxIcon,
  BracesIcon,
  ChartNoAxesColumnIcon,
  FileKeyIcon,
  FileTextIcon,
  FolderIcon,
  HistoryIcon,
  HeartPulseIcon,
  InfoIcon,
  FingerprintIcon,
  LayoutGridIcon,
  LogsIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  PlayIcon,
  RocketIcon,
  ScrollTextIcon,
  ShieldUserIcon,
  UsersIcon,
} from 'lucide-react';

export const globalNavigationItems = [
  { href: '/projects', label: 'Projects', icon: LayoutGridIcon },
  { href: '/deployments', label: 'Deployments', icon: BoxIcon },
  { href: '/usage', label: 'Usage', icon: ChartNoAxesColumnIcon },
] as const;

export const settingsNavigationGroups = [
  {
    label: 'Personal',
    items: [
      { href: '/settings/profile', label: 'Profile', icon: ShieldUserIcon },
      { href: '/settings/git-credentials', label: 'Git credentials', icon: KeyRoundIcon },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/settings/members', label: 'Members', icon: UsersIcon },
      { href: '/settings/identity', label: 'Identity', icon: FingerprintIcon },
      { href: '/settings/shared-agent-environment', label: 'Shared agent environment', icon: LockKeyholeIcon },
      { href: '/settings/health', label: 'Instance health', icon: HeartPulseIcon },
      { href: '/settings/about', label: 'About', icon: InfoIcon },
    ],
  },
] as const;

export function getProjectNavigationItems(projectId: string) {
  const projectHref = `/projects/${projectId}`;

  return [
    { href: projectHref, label: 'Overview', icon: ActivityIcon },
    { href: `${projectHref}/playground`, label: 'Playground', icon: PlayIcon },
    { href: `${projectHref}/sessions`, label: 'Sessions', icon: HistoryIcon },
    { href: `${projectHref}/usage`, label: 'Usage', icon: ChartNoAxesColumnIcon },
    { href: `${projectHref}/schedules`, label: 'Schedules', icon: ScrollTextIcon },
    { href: `${projectHref}/source`, label: 'Source', icon: BracesIcon },
    { href: `${projectHref}/secrets`, label: 'Secrets', icon: FileKeyIcon },
    { href: `${projectHref}/logs`, label: 'Logs', icon: LogsIcon },
  ] as const;
}

export function getProjectIdFromPathname(pathname: string): string | null {
  const [, root, projectId] = pathname.split('/');

  return root === 'projects' && projectId && projectId !== 'new' ? projectId : null;
}

export function isNavigationItemActive(pathname: string, href: string): boolean {
  const segments = href.split('/').filter(Boolean);
  const isProjectOverview = segments[0] === 'projects' && segments.length === 2;

  return pathname === href || (!isProjectOverview && pathname.startsWith(`${href}/`));
}
