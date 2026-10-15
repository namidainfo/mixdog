import {
  isSessionOpenDelivery,
  type DesktopSessionOpenDelivery,
  type DesktopSessionOpenResult,
} from '../shared/session-open-request';

interface SessionOpenTarget {
  send(request: DesktopSessionOpenDelivery): void;
  activate(): void;
}

/** The daemon owns correlation and deadline; main owns renderer delivery only. */
export class SessionOpenRequests {
  private readonly pending: DesktopSessionOpenDelivery[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly settled = new Map<string, number>();
  private target: SessionOpenTarget | null = null;
  private ready = false;
  private inFlight: DesktopSessionOpenDelivery | null = null;

  constructor(
    private readonly report: (event: string, error?: string) => void,
    private readonly receipt: (result: DesktopSessionOpenResult) => void
  ) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  request(value: unknown): boolean {
    if (!isSessionOpenDelivery(value)) {
      this.report('invalid');
      return false;
    }
    for (const [id, expiresAt] of this.settled) if (expiresAt <= Date.now()) this.settled.delete(id);
    if (this.settled.has(value.requestId)) return false;
    const pending = this.pending.find((request) => request.requestId === value.requestId);
    if (value.cancelled) {
      if (pending?.sessionId === value.sessionId) this.finish(pending, 'Session navigation was cancelled.', false);
      else if (!pending) this.settled.set(value.requestId, value.expiresAt);
      return false;
    }
    if (pending) return false;
    if (value.expiresAt <= Date.now()) {
      this.receipt({ requestId: value.requestId, sessionId: value.sessionId, opened: false, error: 'Session navigation expired.' });
      return false;
    }
    const request = { ...value };
    this.pending.push(request);
    this.timers.set(request.requestId, setTimeout(() => this.finish(request, 'Session navigation expired.'), request.expiresAt - Date.now()));
    this.report('queued');
    this.flush();
    return true;
  }

  setTarget(target: SessionOpenTarget | null): void {
    if (this.target && this.target !== target) this.failAll('Desktop renderer disconnected.');
    this.target = target;
    this.ready = false;
  }

  setReady(ready: boolean): void {
    if (this.ready && !ready) this.failAll('Desktop renderer disconnected.');
    this.ready = ready;
    if (ready) this.flush();
  }

  failAll(error: string): void {
    this.ready = false;
    for (const request of [...this.pending]) this.finish(request, error);
  }

  acknowledge(value: unknown): void {
    if (!this.inFlight || !value || typeof value !== 'object') return;
    const result = value as Partial<DesktopSessionOpenResult>;
    if (result.requestId !== this.inFlight.requestId || result.sessionId !== this.inFlight.sessionId ||
        typeof result.opened !== 'boolean') return;
    this.finish(this.inFlight, this.inFlight.expiresAt <= Date.now() ? 'Session navigation expired.' :
      result.opened ? null : typeof result.error === 'string' ? result.error : 'Navigation was not confirmed.');
  }

  private finish(request: DesktopSessionOpenDelivery, error: string | null, reply = true): void {
    const index = this.pending.indexOf(request);
    if (index < 0) return;
    this.pending.splice(index, 1);
    clearTimeout(this.timers.get(request.requestId));
    this.timers.delete(request.requestId);
    this.settled.set(request.requestId, request.expiresAt);
    if (this.inFlight === request) {
      this.inFlight = null;
      if (error && this.target) {
        try { this.target.send({ ...request, cancelled: true }); }
        catch (failure) { this.report('delivery-failed', String(failure)); }
      }
    }
    this.report(error ? 'failed' : 'opened', error ?? undefined);
    if (reply) this.receipt({ requestId: request.requestId, sessionId: request.sessionId, opened: !error, ...(error ? { error } : {}) });
    this.flush();
  }

  private flush(): void {
    if (!this.ready || !this.target || this.inFlight || !this.pending.length) return;
    const request = this.pending[0];
    if (request.expiresAt <= Date.now()) { this.finish(request, 'Session navigation expired.'); return; }
    this.inFlight = request;
    try {
      this.target.activate();
      this.target.send(request);
    } catch (error) {
      this.ready = false;
      this.finish(request, error instanceof Error ? error.message : String(error));
    }
  }
}
