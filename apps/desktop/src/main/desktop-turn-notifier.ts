import type { Notification } from 'electron';
import { createFinalAnswerWatcher } from './final-answer-watcher';
import { shouldShowTurnNotification, type TurnCompletion } from './push-turn-events';
import type { SessionFinalAnswer } from './session-final-answer';
import type { DesktopSessionStateUpdate, DesktopSessionSummary } from '../shared/contract';

type NativeNotification = Pick<Notification, 'on' | 'show' | 'close'>;

interface DesktopTurnNotifierOptions {
  isEnabled(): boolean;
  isSupported(): boolean;
  isForeground(): boolean;
  /** Personal local host only; ordinary and server windows keep click-to-open. */
  focusOnNotify?: boolean;
  readFinalAnswer(sessionId: string, startedAt: number): Promise<SessionFinalAnswer | null>;
  createNotification(content: { title: string; body: string }): NativeNotification;
  playSound?(): Promise<string>;
  openSession(sessionId: string): void;
  diagnostic(event: string, details: Record<string, unknown>): void;
}

/** Completion detection and native delivery share one app-lifetime owner.
 * A native "show" event means OS acceptance, NOT proof that a banner was
 * visible. Keep that distinction in diagnostics and in the live probe. */
export function createDesktopTurnNotifier(options: DesktopTurnNotifierOptions) {
  const live = new Set<NativeNotification>();
  const questions = new Map<string, string>();
  const titles = new Map<string, string>();
  let disposed = false;
  const report = (event: string, sessionId: string, details: Record<string, unknown> = {}) =>
    options.diagnostic(event, { sessionId, ...details });
  const focus = (sessionId: string, reason: 'completion' | 'question'): void => {
    if (!options.focusOnNotify) return;
    try {
      options.openSession(sessionId);
      report('focus-requested', sessionId, { reason });
    } catch (error) {
      report('focus-failed', sessionId, { reason, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const show = (sessionId: string, content: { title: string; body: string }): void => {
    let notification: NativeNotification | undefined;
    try {
      notification = options.createNotification(content);
      const current = notification;
      const release = () => {
        live.delete(current);
      };
      live.add(current);
      let soundStarted = false;
      current.on('show', () => {
        report('os-show', sessionId);
        if (soundStarted || !options.playSound || !options.isEnabled()) return;
        soundStarted = true;
        void options
          .playSound()
          .then((result) => report('sound', sessionId, { result }))
          .catch((error: unknown) =>
            report('sound-failed', sessionId, {
              error: error instanceof Error ? error.message : String(error),
            })
          );
      });
      current.on('close', () => {
        release();
        report('closed', sessionId);
      });
      current.on('failed', (_event, error) => {
        release();
        report('failed', sessionId, { error });
      });
      current.on('click', () => {
        release();
        report('clicked', sessionId);
        options.openSession(sessionId);
      });
      report('requested', sessionId);
      current.show();
    } catch (error) {
      if (notification) live.delete(notification);
      report('failed', sessionId, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const deliver = (completion: TurnCompletion): void => {
    if (disposed || !options.isEnabled()) return;
    // Capture visibility BEFORE activation so bringing Personal forward does
    // not accidentally suppress the background banner/sound it was to raise.
    const foreground = options.isForeground();
    focus(completion.sessionId, 'completion');
    if (!options.isSupported()) {
      report('suppressed', completion.sessionId, { reason: 'unsupported' });
      return;
    }
    if (!shouldShowTurnNotification(completion, foreground)) {
      report('suppressed', completion.sessionId, { reason: 'foreground' });
      return;
    }
    show(completion.sessionId, { title: completion.title, body: completion.preview });
  };

  const watcher = createFinalAnswerWatcher({
    isEnabled: options.isEnabled,
    readFinalAnswer: options.readFinalAnswer,
    onFinalAnswer: deliver,
    onDiagnostic: options.diagnostic,
    onError: (error) => options.diagnostic('read-failed', { error }),
  });
  return {
    onSessions(sessions: readonly DesktopSessionSummary[]) {
      if (disposed) return;
      titles.clear();
      for (const session of sessions) titles.set(session.id, session.title || 'Mixdog Personal');
      watcher.onSessions(sessions);
    },
    onAgentPool: watcher.onAgentPool,
    onSessionState(update: DesktopSessionStateUpdate) {
      if (disposed || !options.focusOnNotify) return;
      if (!update.snapshot) {
        if (update.laneEnd === 'gone') questions.delete(update.sessionId);
        return;
      }
      const key = update.snapshot.userQuestion?.id || null;
      const previous = questions.get(update.sessionId) ?? null;
      // A late replay must not replace a newer live identity or clear it.
      if (update.frameSource === 'replay') {
        if (key && previous === null) questions.set(update.sessionId, key);
        return;
      }
      if (key) questions.set(update.sessionId, key);
      else questions.delete(update.sessionId);
      if (!key || key === previous || !options.isEnabled()) return;
      const foreground = options.isForeground();
      focus(update.sessionId, 'question');
      if (foreground || !options.isSupported()) return;
      show(update.sessionId, { title: titles.get(update.sessionId) || 'Mixdog Personal', body: '사용자의 답변이 필요합니다.' });
    },
    dispose() {
      disposed = true;
      watcher.dispose();
      for (const notification of live) notification.close();
      live.clear();
      questions.clear();
      titles.clear();
    },
  };
}
