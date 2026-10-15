import { useEffect, useRef } from 'react';
import {
  isSessionOpenDelivery,
  type DesktopSessionOpenDelivery,
} from '../shared/session-open-request';

/** Deliberately separate from notification focus-only navigation. */
export function useExistingSessionNavigation({
  ready,
  openSession,
  onError,
}: {
  ready: boolean;
  openSession(sessionId: string, signal: AbortSignal): Promise<void>;
  onError(message: string): void;
}): void {
  const current = useRef({ ready, openSession, onError });
  current.current = { ready, openSession, onError };
  const held = useRef(new Map<string, { request: DesktopSessionOpenDelivery; controller: AbortController }>());
  const drain = useRef<() => void>(() => {});

  useEffect(() => {
    const api = window.mixdogDesktop;
    if (!api?.onSessionOpenRequested) return;
    let active = true;
    let processing = false;
    const process = async () => {
      if (processing || !active || !current.current.ready) return;
      processing = true;
      try {
        for (const [id, { request, controller }] of held.current) {
          if (!active || !current.current.ready) break;
          const timer = window.setTimeout(() => controller.abort(new Error('Session navigation expired.')), Math.max(0, request.expiresAt - Date.now()));
          try {
            // Session identity owns project resolution through its existing
            // lane. Never stage cwd into New Task preferences.
            if (Date.now() >= request.expiresAt) controller.abort(new Error('Session navigation expired.'));
            controller.signal.throwIfAborted();
            await current.current.openSession(request.sessionId, controller.signal);
            if (!active) break;
            controller.signal.throwIfAborted();
            api.sessionOpenHandled?.({ requestId: id, sessionId: request.sessionId, opened: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!active) break;
            current.current.onError(`Could not open the requested session: ${message}`);
            api.sessionOpenHandled?.({
              requestId: id,
              sessionId: request.sessionId,
              opened: false,
              error: message,
            });
          } finally {
            window.clearTimeout(timer);
            held.current.delete(id);
          }
        }
      } finally {
        processing = false;
      }
    };
    drain.current = () => void process();
    const stop = api.onSessionOpenRequested((request) => {
      if (!isSessionOpenDelivery(request)) {
        current.current.onError('Invalid existing-session open request.');
        return;
      }
      if (request.cancelled) {
        held.current.get(request.requestId)?.controller.abort(new Error('Session navigation was cancelled.'));
        held.current.delete(request.requestId);
        return;
      }
      if (held.current.has(request.requestId)) return;
      held.current.set(request.requestId, { request, controller: new AbortController() });
      drain.current();
    });
    return () => {
      active = false;
      for (const { controller } of held.current.values()) controller.abort(new Error('Session navigation surface disconnected.'));
      held.current.clear();
      api.sessionOpenNavigationReady?.(false);
      stop();
      drain.current = () => {};
    };
  }, []);

  useEffect(() => {
    window.mixdogDesktop?.sessionOpenNavigationReady?.(ready);
    if (ready) drain.current();
  }, [ready]);
}
