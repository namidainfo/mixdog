import { randomUUID } from 'node:crypto';

// Only these callbacks cross the private Windows-worker/Slack-bridge pipe.
export const HUB_CALLBACKS = new Set(['conversations', 'authorize', 'sendCode', 'executionAccess']);
export class HubWorkerBridge {
  constructor(send, timeoutMs = 15_000) { this.send = send; this.timeoutMs = timeoutMs; this.pending = new Map(); this.closed = false; }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Slack 브리지 연결이 닫혔습니다.'));
    if (!HUB_CALLBACKS.has(method)) return Promise.reject(new Error('허용되지 않은 공유실 브리지 요청입니다.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('Slack 브리지 응답이 늦습니다. 자동으로 재전송하지 않습니다.'));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve().then(() => {
        if (this.pending.has(id)) return this.send({ event: 'hub', id, method, params });
      }).catch((error) => {
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  receive(id, value) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    if (value?.ok === true) pending.resolve(value.result);
    else pending.reject(new Error('Slack 브리지 요청을 완료하지 못했습니다. 승인 상태와 DM 권한을 확인해 주세요.'));
  }
  close() {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Slack 브리지 연결이 닫혔습니다.')); }
    this.pending.clear();
  }
}
