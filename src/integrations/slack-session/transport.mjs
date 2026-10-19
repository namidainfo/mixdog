import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { HUB_CALLBACKS } from './hub/worker-bridge.mjs';

export class SlackWorkerTransport extends EventEmitter {
  constructor({ node, worker, runtimeRoot, provider, model, effort, contextTokens, maxAttachmentBytes, hubRequest, hubOptions, log = () => {} }) {
    super();
    this.options = { node, worker, runtimeRoot, provider, model, effort, contextTokens, maxAttachmentBytes, hubOptions };
    this.log = log;
    this.hubRequest = hubRequest;
    this.pending = new Map();
    this.child = null;
    this.starting = null;
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new Error('Mixdog 연결이 닫혔습니다.');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.connect().finally(() => { this.starting = null; });
    return this.starting;
  }

  async connect() {
    const o = this.options;
    const child = spawn(o.node, [
      o.worker, '--runtime-root', o.runtimeRoot,
      '--provider', o.provider, '--model', o.model, '--effort', o.effort,
      '--context-tokens', String(o.contextTokens),
      '--max-attachment-bytes', String(o.maxAttachmentBytes),
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const fail = (error) => {
      if (this.child !== child) return;
      this.child = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      if (!this.closed) this.emit('offline', error);
    };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Mixdog worker 종료 (${code})`)));
    child.stderr.on('data', (data) => this.log(String(data).trim()));
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let frame;
      try { frame = JSON.parse(line); } catch {
        this.log('Mixdog worker가 잘못된 프로토콜 응답을 반환했습니다.');
        return;
      }
      if (frame.event === 'state') {
        this.emit('state', frame);
        return;
      }
      if (frame.event === 'hub') {
        const reply = (value) => {
          if (this.child !== child) return;
          child.stdin.write(`${JSON.stringify({ id: frame.id, method: 'hubReply', params: value })}\n`, (error) => { if (error) fail(error); });
        };
        if (!HUB_CALLBACKS.has(frame.method) || typeof frame.id !== 'string' || !this.hubRequest) {
          reply({ ok: false }); return;
        }
        void Promise.resolve().then(() => this.hubRequest(frame.method, frame.params))
          .then((result) => reply({ ok: true, result }), () => reply({ ok: false }));
        return;
      }
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(new Error(frame.error || 'Mixdog worker 요청 실패'));
    });
    try {
      await this.call('health', {});
      if (o.hubOptions) await this.call('startHub', o.hubOptions);
      this.log('Mixdog native session transport ready');
    } catch (error) {
      // A logon can race daemon readiness. Never retain a half-initialized
      // child that makes later start() calls falsely look successful.
      fail(error);
      const timer = setTimeout(() => child.kill(), 5000);
      timer.unref?.();
      child.once('exit', () => clearTimeout(timer));
      child.stdin.end();
      throw error;
    }
  }

  async request(method, params = {}) {
    await this.start();
    return this.call(method, params);
  }

  call(method, params) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Mixdog worker가 연결되어 있지 않습니다.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Mixdog ${method} 응답 시간 초과`));
      }, 120000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error || !this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
