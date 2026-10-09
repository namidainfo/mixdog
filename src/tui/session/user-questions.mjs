import { randomUUID } from 'node:crypto';
import { normalizeUserQuestions, userQuestionResult } from '../../runtime/user-questions/contract.mjs';

// Like approvals, questions belong to the daemon-owned session, not to a
// window or subscription. Disconnect/reload does not answer or cancel them.
// Only the active request can be answered; queued requests were never shown.
export function createUserQuestions({ getState, set, getDisposed, nextId = randomUUID }) {
  const queue = [];
  let active = null;

  function presentNext() {
    if (active || getDisposed()) return;
    active = queue.shift() || null;
    set({ userQuestion: active?.request || null });
  }

  function settle(entry, result) {
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.resolve(result);
  }

  function cancelEntry(entry, reason) {
    if (active === entry) {
      active = null;
      settle(entry, { cancelled: true, answers: {}, reason });
      presentNext();
    } else {
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      settle(entry, { cancelled: true, answers: {}, reason });
    }
  }

  function cancelAllUserQuestions(reason = 'question cancelled') {
    const entries = [...(active ? [active] : []), ...queue];
    active = null;
    queue.length = 0;
    set({ userQuestion: null });
    for (const entry of entries) settle(entry, { cancelled: true, answers: {}, reason });
  }

  async function requestUserQuestion(input) {
    const questions = normalizeUserQuestions({ questions: input.questions });
    const sessionId = String(getState().sessionId || '');
    if (getDisposed() || input.signal?.aborted) {
      return { cancelled: true, answers: {}, reason: getDisposed() ? 'runtime disposed' : 'turn cancelled' };
    }
    if (!sessionId || input.sessionId !== sessionId) {
      throw new Error('user question does not belong to this session');
    }
    return new Promise((resolve) => {
      const entry = {
        request: {
          id: nextId(),
          sessionId,
          toolCallId: input.toolCallId || null,
          questions,
          requestedAt: Date.now(),
        },
        resolve,
        signal: input.signal,
        onAbort: null,
      };
      entry.onAbort = () => cancelEntry(entry, 'turn cancelled');
      queue.push(entry);
      entry.signal?.addEventListener('abort', entry.onAbort, { once: true });
      presentNext();
    });
  }

  function finishUserQuestion(id, response) {
    if (getDisposed() || !active || active.request.id !== id) return false;
    // Validation must finish before changing state or releasing the waiter.
    const result = userQuestionResult(active.request.questions, response);
    const entry = active;
    active = null;
    settle(entry, result);
    presentNext();
    return true;
  }

  return { requestUserQuestion, finishUserQuestion, cancelAllUserQuestions };
}
