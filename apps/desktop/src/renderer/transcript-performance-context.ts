import type { DesktopRendererSessionActivity } from '../shared/contract-workspace';

/** Identifiers and counts only: never prompts, output, or pressed keys. */
export function transcriptPerformanceContext(document: Document): DesktopRendererSessionActivity {
  const visible = [...document.querySelectorAll<HTMLElement>('.transcript[data-session-key]')]
    .filter(node => node.getClientRects().length > 0);
  return {
    sessionKeys: [...new Set(visible.map(node => node.dataset.sessionKey || '').filter(Boolean))].slice(0, 4),
    visibleTranscripts: visible.length,
    toolGroups: visible.reduce((count, node) => count + node.querySelectorAll('.tool-activity').length, 0),
    expandedToolGroups: visible.reduce((count, node) => count + node.querySelectorAll('.tool-activity[data-open="true"]').length, 0),
  };
}
