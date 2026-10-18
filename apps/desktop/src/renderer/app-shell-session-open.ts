import { startTransition } from 'react';
import type { NavigationSelection, WorkspaceTab } from './navigation';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { t } from './i18n';
import { defaultSessionLaneStore } from './session-lane-store';
import { requestSessionRead } from './app-snapshot-views';
import { useExistingSessionNavigation } from './use-existing-session-navigation';

interface SessionOpenProps {
  navigationEpoch: React.MutableRefObject<number>;
  closeSidebarForNavigation: () => void;
  setRequestedSessionId: (id: string) => void;
  sessions: DesktopSessionSummary[];
  tabs: WorkspaceTab[];
  finishPendingConversationHandoff: () => void;
  activateSelection: (selection: NavigationSelection, title: string) => void;
  existingSessionReady?: boolean;
  onSessionOpenError?: (message: string) => void;
}

async function resolveSessionLane(sessionId: string, laneReady: Promise<boolean>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let stop = () => {};
    let settled = false;
    let readAccepted = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stop();
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Session navigation was cancelled.'));
    const inspect = () => {
      if (settled || !readAccepted) return;
      const lane = defaultSessionLaneStore.get(sessionId);
      if (lane) finish(lane.sessionId === sessionId ? undefined : new Error('Requested session lane returned another identity.'));
    };
    stop = defaultSessionLaneStore.subscribe(sessionId, inspect);
    signal.addEventListener('abort', abort, { once: true });
    void laneReady.then((loaded) => {
      if (!loaded) finish(new Error('Requested session could not be loaded.'));
      else { readAccepted = true; inspect(); }
    }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

export function useAppSessionOpen({
  navigationEpoch,
  closeSidebarForNavigation,
  setRequestedSessionId,
  sessions,
  tabs,
  finishPendingConversationHandoff,
  activateSelection,
  existingSessionReady = false,
  onSessionOpenError = (message) => console.error(message),
}: SessionOpenProps) {
  const openSession = async (sessionId: string, _force = false, fallbackTitle = '', confirmation?: AbortSignal): Promise<void> => {
    const navigationToken = ++navigationEpoch.current;
    closeSidebarForNavigation();
    setRequestedSessionId(sessionId);
    // Select immediately; a cold lane fills behind the already-committed tab
    // instead of making the relay RTT part of navigation latency.
    const laneReady = defaultSessionLaneStore.get(sessionId) ? Promise.resolve(true) : requestSessionRead(sessionId);
    const ensureCurrent = () => {
      confirmation?.throwIfAborted();
      if (navigationEpoch.current !== navigationToken) throw new Error('Session navigation was superseded.');
    };
    if (confirmation) {
      try {
        await resolveSessionLane(sessionId, laneReady, confirmation);
        ensureCurrent();
      } finally {
        if (navigationEpoch.current === navigationToken) setRequestedSessionId('');
      }
    } else if (navigationEpoch.current !== navigationToken) return;
    const session = sessions.find((item) => item.id === sessionId);
    finishPendingConversationHandoff();
    // Pin explicit titles such as "Reviewer · tag" across pane moves and
    // catalog refreshes. Re-entering an open tab recovers its pin rather than
    // replacing it with the session's generated title or a placeholder.
    const openedTab = tabs.find((tab) => tab.selection.kind === 'session' && tab.selection.id === sessionId);
    const openedPinnedTitle =
      openedTab && openedTab.selection.kind === 'session' ? String(openedTab.selection.title || '').trim() : '';
    const pinnedTitle = fallbackTitle.trim() || openedPinnedTitle;
    const clearRequested = () => {
      if (navigationEpoch.current === navigationToken) setRequestedSessionId('');
    };
    if (!confirmation) void laneReady.then(clearRequested, clearRequested);
    // Normal clicks render the incoming pane in a transition. Confirmed
    // bridge navigation must propagate failures to its acknowledgement;
    // React reports transition errors instead of throwing them to the caller.
    const activate = () =>
      activateSelection(
        {
          kind: 'session',
          id: sessionId,
          ...(pinnedTitle ? { title: pinnedTitle } : {}),
        },
        pinnedTitle || (session ? sessionSummaryTitle(session, t('Untitled session')) : t('Untitled session'))
      );
    if (confirmation) activate();
    else startTransition(activate);
    if (confirmation) ensureCurrent();
  };

  useExistingSessionNavigation({
    ready: existingSessionReady,
    openSession: (sessionId, signal) => openSession(sessionId, false, '', signal),
    onError: onSessionOpenError,
  });

  return {
    openSession,
  };
}
