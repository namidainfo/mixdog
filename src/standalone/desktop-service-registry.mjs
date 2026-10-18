import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sanitizeForWire } from './session-wire-values.mjs';
import { annotateSpan } from '../runtime/shared/slow-span.mjs';
import { modelProxyClientMode } from '../runtime/shared/model-proxy-mode.mjs';
import { getModelProxyChannel } from '../runtime/agent/orchestrator/providers/model-proxy-channel.mjs';

const requireDesktopModule = createRequire(import.meta.url);

async function loadDesktopServiceModule(moduleUrl) {
  const parsed = new URL(moduleUrl);
  if (!parsed.pathname.toLowerCase().endsWith('.cjs')) {
    return import(moduleUrl);
  }
  // Node's CJS bridge ignores URL search parameters and otherwise returns the
  // previous install's cached exports after an in-place desktop update. Keep
  // already-instantiated adapters alive, but load this newly keyed artifact
  // from disk for the new desktop build.
  const modulePath = fileURLToPath(parsed);
  const resolved = requireDesktopModule.resolve(modulePath);
  delete requireDesktopModule.cache[resolved];
  return requireDesktopModule(resolved);
}

function subscriberToken(ctx) {
  return ctx?.clientToken ? String(ctx.clientToken) : '';
}

function desktopEventKey(desktopId, message) {
  const kind = String(message?.kind || 'event');
  if (kind === 'session-state') {
    return `desktop-event:${desktopId}:${kind}:${String(message?.sessionId || '')}`;
  }
  // Service events are NOT one lane. Under one shared `desktop-event` key a
  // terminal flood clobbered LSP/folder events — and every other terminal —
  // whenever the stream backed up, because the backlog is latest-wins per
  // key. Name (and terminal id) keep each producer on its own key.
  if (kind === 'desktop-event') {
    const name = String(message?.name || '');
    let terminalId = '';
    if (name === 'terminal-data') terminalId = String(message?.value?.id || '');
    else if (name === 'session-runtime-released') terminalId = String(message?.value?.sessionId || '');
    else if (name === 'session-open-request') terminalId = String(message?.value?.requestId || '');
    return `desktop-event:${desktopId}:${kind}:${name}${terminalId ? `:${terminalId}` : ''}`;
  }
  return `desktop-event:${desktopId}:${kind}`;
}

export class DesktopServiceRegistry {
  #runtime;
  #onFrame;
  #log;
  #onExternalClientsChanged;
  #onReady;
  #servicesById = new Map();
  #servicesByModule = new Map();
  #servicePromises = new Map();
  #pendingIds = new Map();
  #closed = false;
  #disposePromise = null;
  #sessionOpenRequests = new Map();
  #sessionOpenTimeoutMs;

  constructor({
    runtime = null,
    onFrame = () => {},
    log = () => {},
    onExternalClientsChanged = () => {},
    onReady = () => {},
    sessionOpenTimeoutMs = 30_000,
  } = {}) {
    this.#runtime = runtime;
    this.#onFrame = onFrame;
    this.#log = log;
    this.#onExternalClientsChanged = onExternalClientsChanged;
    this.#onReady = onReady;
    this.#sessionOpenTimeoutMs = sessionOpenTimeoutMs;
  }

  #publish(desktopId, message, recipients = null) {
    const wire = sanitizeForWire(message);
    const service = this.#servicesById.get(desktopId);
    if (!wire || !service) return;
    this.#onFrame(
      {
        type: 'desktop-event',
        key: desktopEventKey(desktopId, wire),
        desktopId,
        message: wire,
      },
      recipients ?? service.subscribers
    );
  }

  #require(desktopId) {
    const id = String(desktopId || '');
    const service = this.#servicesById.get(id);
    if (!service) throw new Error('desktop service is not initialized');
    return service;
  }

  async #discard(instance, reason) {
    if (typeof instance?.dispose !== 'function') return;
    try {
      await instance.dispose(reason);
    } catch (error) {
      this.#log(`desktop service dispose failed: ${error?.message || error}`);
    }
  }

  async #initialize({ desktopId, moduleUrl, options = {} } = {}) {
    if (this.#closed) throw new Error('session service is closed');
    const requestedId = String(desktopId || '').trim();
    if (!requestedId || !/^[A-Za-z0-9_-]+$/.test(requestedId)) {
      throw new TypeError('desktopId is invalid');
    }
    const requestedModule = String(moduleUrl || '').trim();
    let parsed;
    try {
      parsed = new URL(requestedModule);
    } catch {
      throw new TypeError('desktop service moduleUrl is invalid');
    }
    if (parsed.protocol !== 'file:') {
      throw new TypeError('desktop service moduleUrl must be a file URL');
    }
    const existingById = this.#servicesById.get(requestedId);
    const pendingId = this.#pendingIds.get(requestedId);
    const boundModule = existingById?.moduleUrl || pendingId?.moduleUrl;
    if (boundModule && boundModule !== requestedModule) {
      throw new Error(`desktopId ${requestedId} is already bound to another service module`);
    }
    if (existingById) return existingById;
    if (pendingId) return pendingId.promise;
    const existingByModule = this.#servicesByModule.get(requestedModule);
    if (existingByModule) return existingByModule;
    const pending = this.#servicePromises.get(requestedModule);
    if (pending) return pending;
    const loading = (async () => {
      const loaded = await loadDesktopServiceModule(requestedModule);
      if (this.#closed) throw new Error('session service is closed');
      if (typeof loaded.createDesktopService !== 'function') {
        throw new TypeError('desktop service module has no createDesktopService export');
      }
      let record = null;
      const ownsRecord = () => record !== null && this.#servicesById.get(requestedId) === record;
      const instance = await loaded.createDesktopService({
        options: sanitizeForWire(options) || {},
        runtime: this.#runtime,
        emit: (message) => {
          if (ownsRecord()) this.#publish(requestedId, message);
        },
        onClientCountChanged: () => {
          if (!ownsRecord()) return;
          try {
            this.#onExternalClientsChanged();
          } catch {}
        },
      });
      if (!instance || typeof instance.invoke !== 'function' || typeof instance.control !== 'function') {
        await this.#discard(instance, 'desktop service adapter is invalid');
        throw new TypeError('desktop service adapter is invalid');
      }
      if (this.#closed) {
        await this.#discard(instance, 'session service is closed');
        throw new Error('session service is closed');
      }
      record = {
        desktopId: requestedId,
        moduleUrl: requestedModule,
        instance,
        subscribers: new Set(),
        receivers: new Set(),
        visibilityEpochs: new Map(),
        nextVisibilityEpoch: 0,
      };
      this.#servicesById.set(requestedId, record);
      this.#servicesByModule.set(requestedModule, record);
      this.#log(`desktop service loaded id=${requestedId} module=${requestedModule}`);
      return record;
    })();
    this.#servicePromises.set(requestedModule, loading);
    this.#pendingIds.set(requestedId, { moduleUrl: requestedModule, promise: loading });
    try {
      return await loading;
    } finally {
      if (this.#servicePromises.get(requestedModule) === loading) {
        this.#servicePromises.delete(requestedModule);
      }
      if (this.#pendingIds.get(requestedId)?.promise === loading) this.#pendingIds.delete(requestedId);
    }
  }

  async init(params = {}, ctx = null) {
    const service = await this.#initialize(params);
    if (this.#closed) throw new Error('session service is closed');
    const token = subscriberToken(ctx);
    if (token) {
      service.subscribers.add(token);
      // The adapter outlives desktop processes, whose request counters restart.
      // Allocate the ordering namespace here, not from a client's wall clock.
      if (!service.visibilityEpochs.has(token)) {
        service.visibilityEpochs.set(token, ++service.nextVisibilityEpoch);
      }
    }
    this.#syncModelProxyPresence();
    return { desktopId: service.desktopId };
  }

  // Proxied model calls need a live desktop subscriber; tell the channel the
  // moment the last one leaves instead of waiting for its claim timeout.
  #syncModelProxyPresence() {
    if (!modelProxyClientMode()) return;
    let present = false;
    for (const service of this.#servicesById.values()) {
      if (service.subscribers.size) {
        present = true;
        break;
      }
    }
    getModelProxyChannel().setClientPresent(present);
  }

  // Every addressed call also (re)subscribes its caller to the service lane.
  #requireSubscribed(desktopId, ctx) {
    const service = this.#require(desktopId);
    const token = subscriberToken(ctx);
    if (token) service.subscribers.add(token);
    return { service, token };
  }

  async invoke({ desktopId, method, args = [] } = {}, ctx = null) {
    if (method === 'invokeDesktopOperation' && args?.[0] === 'sessionOpenHandled') {
      return this.#acknowledgeSessionOpen(desktopId, subscriberToken(ctx), args[1]?.[0]);
    }
    const { service, token } = this.#requireSubscribed(desktopId, ctx);
    const name = String(method || '');
    if (!name) throw new TypeError('desktop service method is required');
    let callArgs = Array.isArray(args) ? args : [];
    if (name === 'setVisibleSessions' && token) {
      const epoch = service.visibilityEpochs.get(token);
      if (epoch === undefined) {
        service.subscribers.delete(token);
        throw new Error('desktop service client is not initialized');
      }
      callArgs = [callArgs[0], callArgs[1], epoch];
    }
    // `[slow-op] desktop.invoke` names the call it timed: a desktop operation
    // (Git reads) or a session capability, not only the generic route.
    const target = name === 'invokeDesktopOperation' || name === 'invokeCapability' ? String(args?.[0] || '') : '';
    annotateSpan(target ? `${name}:${target}` : name);
    return sanitizeForWire(await service.instance.invoke(name, callArgs)) ?? null;
  }

  async control({ desktopId, message } = {}, ctx = null) {
    const { service } = this.#requireSubscribed(desktopId, ctx);
    await service.instance.control(sanitizeForWire(message) || {});
    return { ok: true };
  }

  ready({ desktopId } = {}, ctx = null) {
    const { service, token } = this.#requireSubscribed(desktopId, ctx);
    if (token) service.receivers.add(token);
    this.#syncModelProxyPresence();
    this.#onReady({ desktopId: service.desktopId, clientToken: token || null });
    return { ok: true };
  }

  async unsubscribe({ desktopId } = {}, ctx = null) {
    const service = this.#require(desktopId);
    const token = subscriberToken(ctx);
    this.#disconnectSessionOpens(service.desktopId, token);
    service.receivers.delete(token);
    if (token) await this.#releaseSubscriber(service, token);
    this.#syncModelProxyPresence();
    return { ok: true, unsubscribed: true };
  }

  releaseClient(clientToken) {
    const token = String(clientToken || '');
    if (!token) return;
    for (const service of this.#servicesById.values()) {
      this.#disconnectSessionOpens(service.desktopId, token);
      service.receivers.delete(token);
      void this.#releaseSubscriber(service, token).catch((error) => {
        this.#log(`desktop visibility release failed: ${error?.message || error}`);
      });
    }
    this.#syncModelProxyPresence();
  }

  async #releaseSubscriber(service, token) {
    service.subscribers.delete(token);
    const epoch = service.visibilityEpochs.get(token);
    service.visibilityEpochs.delete(token);
    if (epoch !== undefined) await service.instance.releaseClient?.(epoch);
  }

  notifySessionRuntimeReleased(sessionId, reason) {
    // An evicted session has NO session subscribers. Its desktop resources
    // still belong to the desktop service and must be notified on that lane.
    for (const desktopId of this.#servicesById.keys()) {
      this.#publish(desktopId, {
        kind: 'desktop-event',
        name: 'session-runtime-released',
        value: { sessionId, restore: reason === 'idle and unwatched' },
      });
    }
  }

  async requestSessionOpen(sessionId, cwd, { signal } = {}) {
    signal?.throwIfAborted();
    for (const [desktopId, service] of this.#servicesById) {
      const token = [...service.receivers].find((value) => service.subscribers.has(value));
      if (!token) continue;
      const requestId = randomUUID();
      const delivery = { requestId, sessionId, cwd, expiresAt: Date.now() + this.#sessionOpenTimeoutMs };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.#finishSessionOpen(requestId, new Error('Desktop session navigation timed out.')), this.#sessionOpenTimeoutMs);
        const abort = () => this.#finishSessionOpen(requestId, new Error('Desktop session navigation cancelled by caller.'));
        this.#sessionOpenRequests.set(requestId, { desktopId, token, delivery, timer, resolve, reject, signal, abort });
        signal?.addEventListener('abort', abort, { once: true });
        try {
          if (signal?.aborted) { abort(); return; }
          this.#publish(desktopId, { kind: 'desktop-event', name: 'session-open-request', value: delivery }, new Set([token]));
        } catch (error) {
          this.#finishSessionOpen(requestId, error);
        }
      });
    }
    throw new Error('Mixdog desktop is not connected. Open Mixdog Personal before handing off this session.');
  }

  #acknowledgeSessionOpen(desktopId, token, result) {
    const request = this.#sessionOpenRequests.get(result?.requestId);
    if (!request || request.desktopId !== desktopId || request.token !== token ||
        result.sessionId !== request.delivery.sessionId || typeof result.opened !== 'boolean') return false;
    if (request.signal?.aborted) {
      request.abort();
      return false;
    }
    if (Date.now() >= request.delivery.expiresAt) {
      this.#finishSessionOpen(result.requestId, new Error('Desktop session navigation timed out.'));
      return false;
    }
    this.#finishSessionOpen(result.requestId, result.opened ? null : new Error(
      typeof result.error === 'string' ? result.error : 'Desktop session navigation failed.'));
    return true;
  }

  #finishSessionOpen(requestId, error = null) {
    const request = this.#sessionOpenRequests.get(requestId);
    if (!request) return;
    this.#sessionOpenRequests.delete(requestId);
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    if (error) {
      try {
        this.#publish(request.desktopId, {
          kind: 'desktop-event', name: 'session-open-request', value: { ...request.delivery, cancelled: true },
        }, new Set([request.token]));
      } catch (deliveryError) {
        this.#log(`session open cancellation delivery failed: ${deliveryError.message}`);
      }
      request.reject(error);
    } else request.resolve({ sessionId: request.delivery.sessionId, cwd: request.delivery.cwd });
  }

  #disconnectSessionOpens(desktopId, token) {
    for (const [requestId, request] of this.#sessionOpenRequests) {
      if (request.desktopId === desktopId && request.token === token)
        this.#finishSessionOpen(requestId, new Error('Desktop disconnected during session navigation.'));
    }
  }

  async dispose(reason = 'service stop') {
    if (this.#disposePromise) return this.#disposePromise;
    this.#closed = true;
    for (const requestId of this.#sessionOpenRequests.keys())
      this.#finishSessionOpen(requestId, new Error('Session service stopped during desktop navigation.'));
    const services = [...new Set(this.#servicesById.values())];
    this.#servicesById.clear();
    this.#servicesByModule.clear();
    this.#servicePromises.clear();
    this.#pendingIds.clear();
    this.#disposePromise = Promise.resolve().then(async () => {
      for (const service of services) await this.#discard(service.instance, reason);
    });
    return this.#disposePromise;
  }

  get externalClientCount() {
    let total = 0;
    for (const service of this.#servicesById.values()) {
      const count = Number(service?.instance?.clientCount ?? 0);
      if (Number.isSafeInteger(count) && count > 0) total += count;
    }
    return total;
  }
}
