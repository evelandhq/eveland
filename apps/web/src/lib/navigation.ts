import {
  ActivityIcon,
  BoxIcon,
  BracesIcon,
  ChartNoAxesColumnIcon,
  HistoryIcon,
  HeartPulseIcon,
  InfoIcon,
  FingerprintIcon,
  LayoutGridIcon,
  LogsIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  PlayIcon,
  RadioTowerIcon,
  RocketIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldUserIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';

export type NavigationRole = 'admin' | 'member';

export type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export type SettingsNavigationItem = NavigationItem & {
  access: 'all' | 'admin';
};

export type SettingsNavigationGroup = {
  label: string;
  items: readonly SettingsNavigationItem[];
};

export const globalNavigationItems = [
  { href: '/projects', label: 'Projects', icon: LayoutGridIcon },
  { href: '/deployments', label: 'Deployments', icon: BoxIcon },
  { href: '/usage', label: 'Usage', icon: ChartNoAxesColumnIcon },
] as const;

export const settingsNavigationGroups = [
  {
    label: 'Personal',
    items: [
      { href: '/settings/profile', label: 'Profile', icon: ShieldUserIcon, access: 'all' },
      { href: '/settings/git-credentials', label: 'Git credentials', icon: KeyRoundIcon, access: 'all' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/settings/members', label: 'Members', icon: UsersIcon, access: 'all' },
      { href: '/settings/identity', label: 'Identity', icon: FingerprintIcon, access: 'admin' },
      { href: '/settings/shared-agent-environment', label: 'Shared agent environment', icon: LockKeyholeIcon, access: 'admin' },
      { href: '/settings/observability', label: 'Observability', icon: RadioTowerIcon, access: 'admin' },
      { href: '/settings/health', label: 'Instance health', icon: HeartPulseIcon, access: 'admin' },
      { href: '/settings/about', label: 'About', icon: InfoIcon, access: 'all' },
    ],
  },
] as const satisfies readonly SettingsNavigationGroup[];

export function getSettingsNavigationGroups(
  role: NavigationRole | null,
): readonly SettingsNavigationGroup[] {
  return settingsNavigationGroups.map((group) => ({
    label: group.label,
    items: group.items.filter(
      (item) => item.access === 'all' || role === 'admin',
    ),
  }));
}

export function getProjectNavigationItems(projectId: string) {
  const projectHref = `/projects/${projectId}`;

  return [
    { href: projectHref, label: 'Overview', icon: ActivityIcon, section: 'daily' },
    { href: `${projectHref}/playground`, label: 'Playground', icon: PlayIcon, section: 'daily' },
    { href: `${projectHref}/sessions`, label: 'Sessions', icon: HistoryIcon, section: 'daily' },
    { href: `${projectHref}/logs`, label: 'Logs', icon: LogsIcon, section: 'daily' },
    { href: `${projectHref}/schedules`, label: 'Schedules', icon: ScrollTextIcon, section: 'daily' },
    { href: `${projectHref}/usage`, label: 'Usage', icon: ChartNoAxesColumnIcon, section: 'daily' },
    { href: `${projectHref}/deployments`, label: 'Deployments', icon: RocketIcon, section: 'manage' },
    { href: `${projectHref}/source`, label: 'Source', icon: BracesIcon, section: 'manage' },
    { href: `${projectHref}/settings`, label: 'Settings', icon: SettingsIcon, section: 'manage' },
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
