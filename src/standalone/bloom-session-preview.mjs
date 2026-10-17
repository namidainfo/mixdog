import { normalize } from 'node:path';
import { bloomSessionPurpose } from '../runtime/shared/desktop-session-metadata.mjs';
import { bloomSessionTitle } from '../runtime/shared/bloom-session-title.mjs';
import { fallbackTitleFromText } from '../runtime/agent/orchestrator/session/manager/session-fallback-title.mjs';

const untitled = (title) => !String(title || '').trim() || /^untitled(?:\s+session)?$/i.test(title.trim());
const projectKey = (path) => {
  const key = path ? normalize(path) : '';
  return process.platform === 'win32' ? key.toLowerCase() : key;
};

// Links come from Bloom's persisted session IDs, never a prompt/name heuristic.
// This produces proposals only; there is deliberately no apply operation.
export function previewBloomSessionChanges(rows, { projectPath, links = [], manualTitles = {} }) {
  const linked = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    if (typeof link?.sessionId === 'string' && link.sessionId) linked.set(link.sessionId, link);
  }
  const seen = new Set();
  let unverifiedUntitledCount = 0;
  const changes = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.id !== 'string') continue;
    seen.add(row.id);
    const purpose = bloomSessionPurpose(row.desktopSession);
    const link = linked.get(row.id);
    const hasManualTitle = !!manualTitles && Object.hasOwn(manualTitles, row.id);
    const currentTitle = String(hasManualTitle ? manualTitles[row.id] : row.title || '');
    if (!purpose && !link) {
      if (untitled(currentTitle)) unverifiedUntitledCount += 1;
      continue;
    }
    const locked = hasManualTitle || row.titleLocked === true;
    const metadata = {
      classification: 'project', projectPath, source: 'bloom',
      purpose: purpose || (link?.mode === 'work' ? 'work' : 'chat'),
    };
    const body = fallbackTitleFromText(link?.firstUserText || row.preview || '') || '새 대화';
    const proposedTitle = !locked && untitled(currentTitle)
      ? bloomSessionTitle({ ...row, desktopSession: metadata }, body)
      : currentTitle;
    const currentProjectPath = purpose
      ? row.desktopSession.projectPath || ''
      : row.workspace?.projectPath || row.cwd || row.desktopSession?.projectPath || '';
    changes.push({
      sessionId: row.id,
      sourceEvidence: purpose ? 'stored-bloom-origin' : 'bloom-session-link',
      currentProjectPath, proposedProjectPath: projectPath,
      currentTitle, proposedTitle, manualTitle: locked,
      needsProjectMove: projectKey(currentProjectPath) !== projectKey(projectPath),
      needsTitleChange: currentTitle !== proposedTitle,
    });
  }
  return {
    readOnly: true, projectPath, changes, unverifiedUntitledCount,
    unmatchedSessionIds: [...linked.keys()].filter((id) => !seen.has(id)),
  };
}
