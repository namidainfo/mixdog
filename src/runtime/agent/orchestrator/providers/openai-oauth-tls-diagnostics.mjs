// Diagnostic-only observation. Never changes CA, sockets, dispatchers, or TLS validation.
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { X509Certificate, randomUUID } from 'node:crypto';
import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';

const context = new AsyncLocalStorage();
const sockets = channel('net.client.socket');
const MAX_BYTES = 256 * 1024;
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const text = value => typeof value === 'string' ? value.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 160) : null;

function codes(error) {
  const result = [];
  const seen = new Set();
  for (let item = error; item && typeof item === 'object' && !seen.has(item) && seen.size < 8; item = item.cause) {
    seen.add(item);
    const code = safeCode(item.code);
    if (code && !result.includes(code)) result.push(code);
  }
  return result;
}

function fingerprints(type) {
  return new Set(getCACertificates(type).map(pem => new X509Certificate(pem).fingerprint256));
}

function append(record) {
  const directory = process.env.MIXDOG_DATA_DIR;
  if (!directory) return;
  const path = join(directory, 'oauth-tls-diagnostics.jsonl');
  try {
    const line = `${JSON.stringify(record)}\n`;
    let size = 0;
    try { size = statSync(path).size; } catch (error) { if (error.code !== 'ENOENT') return; }
    if (size + Buffer.byteLength(line) <= MAX_BYTES) appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // A diagnostic write must never change authentication results.
  }
}

/** Injectable writer/host support local TLS tests without any provider requests. */
export function createOAuthTlsDiagnostics({ write = append, host = 'auth.openai.com' } = {}) {
  return async function observe(operation) {
    const id = randomUUID();
    let defaults;
    let system;
    try {
      defaults = fingerprints('default');
      system = fingerprints('system');
    } catch {
      defaults = new Set();
      system = new Set();
    }
    const emit = record => {
      try { write({ timestamp: new Date().toISOString(), id, pid: process.pid, ...record }); } catch {}
    };
    const state = { id, count: 0 };
    const cleanup = [];
    const onSocket = ({ socket }) => {
      if (context.getStore() !== state || typeof socket?.getPeerCertificate !== 'function') return;
      const number = ++state.count;
      if (number > 8) return;
      const secure = () => {
        if (socket.servername !== host) return;
        try {
          const chain = [];
          const seen = new Set();
          let cert = socket.getPeerCertificate(true);
          while (cert?.fingerprint256 && !seen.has(cert.fingerprint256) && chain.length < 8) {
            const fingerprint = cert.fingerprint256;
            if (!/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint)) break;
            seen.add(fingerprint);
            chain.push({
              subject: { CN: text(cert.subject?.CN), O: text(cert.subject?.O) },
              issuer: { CN: text(cert.issuer?.CN), O: text(cert.issuer?.O) },
              sha256: fingerprint,
              inDefaultCA: defaults.has(fingerprint),
              inWindowsCA: system.has(fingerprint),
            });
            cert = cert.issuerCertificate;
          }
          emit({ event: 'peer-chain-before-verification', socket: number, host, chain });
        } catch { emit({ event: 'peer-chain-unavailable', socket: number, host }); }
      };
      const failure = error => {
        if (socket.servername === host) emit({ event: 'tls-error', socket: number, host, codes: codes(error) });
      };
      const success = () => {
        if (socket.servername === host) emit({ event: 'tls-verified', socket: number, host, authorized: socket.authorized === true });
      };
      socket.prependOnceListener('secure', secure);
      socket.once('error', failure);
      socket.once('secureConnect', success);
      cleanup.push(() => {
        socket.removeListener('secure', secure);
        socket.removeListener('error', failure);
        socket.removeListener('secureConnect', success);
      });
    };
    emit({
      event: 'exchange-start',
      host,
      executable: process.execPath,
      node: process.versions.node,
      electron: process.versions.electron || null,
      runtimeModule: import.meta.url,
      systemCAEnabled: process.env.NODE_USE_SYSTEM_CA === '1' || process.execArgv.includes('--use-system-ca') ||
        /(?:^|\s)--use-system-ca(?:\s|$)/.test(process.env.NODE_OPTIONS || ''),
      extraCAConfigured: Boolean(process.env.NODE_EXTRA_CA_CERTS),
      defaultCACount: defaults.size,
      windowsCACount: system.size,
    });
    sockets.subscribe(onSocket);
    try {
      const result = await context.run(state, operation);
      emit({ event: 'exchange-response', observedNewSockets: state.count, status: Number(result?.status) || null });
      return result;
    } catch (error) {
      emit({ event: 'exchange-failed', observedNewSockets: state.count, codes: codes(error) });
      throw error;
    } finally {
      sockets.unsubscribe(onSocket);
      for (const remove of cleanup) remove();
    }
  };
}

const observe = createOAuthTlsDiagnostics();
export function withOAuthTlsDiagnostics(operation) {
  return process.env.MIXDOG_PERSONAL === '1' && process.env.MIXDOG_OAUTH_TLS_DIAGNOSTICS === '1'
    ? observe(operation)
    : operation();
}
