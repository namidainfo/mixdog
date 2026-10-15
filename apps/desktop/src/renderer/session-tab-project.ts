import type { DesktopProjectSummary, DesktopSessionSummary } from '../shared/contract';

function projectKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export function sessionTabProject(
  title: string,
  session: DesktopSessionSummary | undefined,
  projects: readonly DesktopProjectSummary[],
  unclassified: string
): { title: string; tooltip: string } {
  const path = session?.projectPath;
  const project = path ? projects.find((item) => projectKey(item.path) === projectKey(path)) : undefined;
  const name = path
    ? project?.alias || project?.name || path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
    : unclassified;
  return {
    title: `[${name}] ${title}`,
    tooltip: [name, session?.cwd || path, title].filter(Boolean).join('\n'),
  };
}
