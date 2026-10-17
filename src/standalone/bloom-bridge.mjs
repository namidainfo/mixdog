// Finite, authenticated Bloom facade. stdout is ONLY the allowlisted JSONL
// protocol; daemon/account credentials never leave session-client.mjs.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { normalizeUserQuestionResponse } from '../runtime/user-questions/contract.mjs';
import { schemaValueError } from '../runtime/shared/schema-value-error.mjs';
import { safeErrorDetails } from '../runtime/shared/error-presentation.mjs';
import { SESSION_PROTOCOL } from './session-wire.mjs';
import bloomContract from './bloom-contract.json' with { type: 'json' };
import { BLOOM_PROJECT_ALIAS, bloomSessionPurpose } from '../runtime/shared/desktop-session-metadata.mjs';
import { compactSessionTitle } from '../runtime/agent/orchestrator/runtime-core/session-title.mjs';
import { previewBloomSessionChanges } from './bloom-session-preview.mjs';

export function requireBloomRuntime(health) {
  if (!health || health.protocol !== SESSION_PROTOCOL || !Number.isSafeInteger(health.revision) || health.revision < bloomContract.revision)
    throw new Error(`The Bloom bridge requires session protocol ${SESSION_PROTOCOL}, revision ${bloomContract.revision} or newer. Update/open a compatible runtime explicitly; Bloom will not restart it.`);
}

const array = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === 'string' ? value : '';
const pick = (value, keys) => Object.fromEntries(keys
  .filter((key) => value?.[key] === null || ['string', 'number', 'boolean'].includes(typeof value?.[key]))
  .map((key) => [key, typeof value[key] === 'string' ? safeErrorDetails(value[key]) : value[key]]));

// This is deliberately an allowlist, not a recursive key-name blacklist.
export function sanitizeBloomUsage(value) {
  const window = (row) => pick(row, [
    'id', 'label', 'source', 'usedPct', 'remainingPct', 'resetAt', 'windowSeconds',
    'remainingUsd', 'limitUsd', 'usedUsd', 'remainingCredits', 'limitCredits', 'usedCredits',
  ]);
  const row = (item, account = false) => ({
    ...pick(item, [
      'id', 'provider', 'label', 'kind', 'authenticated', 'enabled', 'status', 'stale', 'updatedAt',
      'accountId', 'alias', 'identity', 'selected', 'source', 'sourceLabel', 'primary', 'tone',
      'remainingPct', 'usedPct', 'remainingUsd', 'usedUsd', 'limitUsd', 'refreshState',
    ]),
    windows: array(item?.windows).map(window),
    ...(!account && Array.isArray(item?.accounts) ? { accounts: item.accounts.map((item) => row(item, true)) } : {}),
  });
  return {
    ...pick(value, ['title', 'subtitle', 'checkedAt', 'refresh', 'checking']),
    rows: array(value?.rows).map((item) => row(item)),
  };
}

function snapshot(state, mode) {
  const item = (row) => ({
    id: text(row.id), kind: text(row.kind), text: text(row.text),
    ...pick(row, ['status', 'detail']),
  });
  const question = state.userQuestion;
  const approval = state.toolApproval;
  return {
    sessionId: text(state.sessionId), provider: text(state.provider), model: text(state.model),
    cwd: text(state.cwd), mode, busy: state.busy === true,
    items: array(state.items).filter((row) => ['assistant', 'user', 'turndone'].includes(row?.kind)).map(item),
    streamingTail: state.streamingTail ? item(state.streamingTail) : null,
    status: text(state.commandStatus) || text(state.progressHint?.text) || null,
    question: question ? {
      id: text(question.id), sessionId: text(question.sessionId),
      questions: array(question.questions).map((entry) => ({
        id: text(entry.id), question: text(entry.question), header: text(entry.header) || null,
        options: array(entry.options).map((option) => ({ label: text(option.label), description: text(option.description) || null })),
      })),
    } : null,
    approval: approval ? {
      id: text(approval.id), name: text(approval.name), reason: safeErrorDetails(approval.reason),
      // Tool input is shown only for explicit work approvals. It is NOT config.
      args: mode === 'work' ? approval.args ?? null : null,
    } : null,
  };
}

async function imagePrompt(prompt, images) {
  if (!images?.length) return prompt;
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  const parts = [{ type: 'text', text: prompt }];
  for (const path of images) {
    const mimeType = types[extname(path).toLowerCase()];
    if (!mimeType) throw new TypeError('Unsupported attached image type.');
    const data = await readFile(path);
    if (data.length > 50 * 1024 * 1024) throw new RangeError('Attached image exceeds 50 MiB.');
    parts.push({ type: 'image', mimeType, data: data.toString('base64') });
  }
  return parts;
}

export function createBloomBridge({ createSession, emit = () => {}, cwd = process.cwd(), projectPath = null, makePrompt = imagePrompt }) {
  const views = new Map();
  let gatewayPromise;
  let bloomProjectPath = text(projectPath).trim();
  const gateway = () => gatewayPromise ??= createSession({
    cwd, toolMode: 'none',
    desktopSession: { classification: 'task', projectPath: null, source: 'bloom', purpose: 'gateway' },
  }).catch((error) => {
    // A failed discovery is not a permanent connection. Retry only on the next caller's request.
    gatewayPromise = undefined;
    throw error;
  });
  async function bloomMetadata(purpose, titleHint = '') {
    if (!bloomProjectPath) {
      const projects = array(await (await gateway()).listProjects())
        .filter((row) => (row.alias || row.name) === BLOOM_PROJECT_ALIAS);
      if (projects.length !== 1 || !text(projects[0].path).trim()) {
        throw new Error('Register exactly one project named Bloom in Mixdog Personal before starting a Bloom conversation.');
      }
      bloomProjectPath = projects[0].path.trim();
    }
    if (bloomProjectPath.includes('\0')) throw new TypeError('Bloom project path is invalid.');
    return {
      classification: 'project', projectPath: bloomProjectPath, source: 'bloom', purpose,
      ...(titleHint ? { titleHint } : {}),
    };
  }
  const modeFor = (mode) => {
    if (!['chat', 'work'].includes(mode)) throw new TypeError('Chat mode must be chat or work.');
    return mode === 'work' ? 'full' : 'questions';
  };
  const models = async () => {
    const api = await gateway();
    const [catalog, setup] = await Promise.all([api.listProviderModels(), api.getProviderSetup({ force: true })]);
    const connected = new Set([...array(setup.api), ...array(setup.oauth), ...array(setup.local)]
      .filter((row) => row.authenticated === true && row.enabled !== false && row.usable !== false && row.reauthRequired !== true)
      .map((row) => row.id));
    return array(catalog).filter((row) => connected.has(row.provider) && row.id).map((row) => ({
      key: `mixdog:${row.provider}/${row.id}`, provider: row.provider, model: row.id,
      name: text(row.display) || row.id,
      efforts: array(row.effortOptions).map((option) => typeof option === 'string' ? option : option.value).filter((value) => typeof value === 'string'),
      defaultEffort: text(row.savedEffort) || text(row.defaultEffort) || null,
    }));
  };
  async function route(key, effort) {
    const model = (await models()).find((row) => row.key === key);
    if (!model) throw new Error('The selected model is not routable through a connected Mixdog account. Select an available model.');
    if (effort && !model.efforts.includes(effort)) throw new Error('The selected effort is not supported by this model.');
    return model;
  }
  function checked(entry) {
    const state = entry.api.getState();
    if (state.sessionId !== entry.sessionId) throw new Error('Mixdog session identity changed; no prompt was rerouted.');
    if (state.provider !== entry.model.provider || state.model !== entry.model.model)
      throw new Error('Mixdog model route changed; no prompt was rerouted.');
    return state;
  }
  function view(id) {
    const entry = views.get(id);
    if (!entry) throw new Error('Bloom session view is not open.');
    return entry;
  }
  function publish(entry) {
    try {
      const state = checked(entry);
      const turn = entry.turn;
      const terminal = array(state.items).findLast((item) => item.kind === 'turndone');
      if (turn?.dispatched && !state.busy && terminal && terminal.id !== turn.terminalBefore) entry.turn = null;
      emit({ event: 'state', viewId: entry.viewId, turnId: turn?.id ?? null, snapshot: snapshot(state, entry.mode) });
    } catch (error) {
      emit({ event: 'error', viewId: entry.viewId, turnId: entry.turn?.id ?? null, error: safeErrorDetails(error.message) });
    }
  }
  async function open(args, signal) {
    if (!text(args.viewId) || views.has(args.viewId)) throw new TypeError('A unique viewId is required.');
    const model = await route(args.modelKey, args.effort);
    const toolMode = modeFor(args.mode);
    const api = await createSession({
      cwd, sessionId: args.sessionId || undefined, provider: model.provider, model: model.model,
      effort: args.effort || undefined, toolMode,
      ...(!args.sessionId ? { desktopSession: await bloomMetadata(args.mode) } : {}),
    });
    try {
      if (signal?.aborted) throw new Error('Session attachment cancelled.');
      const state = api.getState();
      const sessionId = text(args.sessionId) || text(state.sessionId);
      if (!sessionId || state.sessionId !== sessionId) throw new Error('Mixdog returned another session identity.');
      if (state.provider !== model.provider || state.model !== model.model)
        throw new Error('The existing session uses another model. Select its actual route or explicitly start a new chat.');
      if (state.busy && state.toolMode !== toolMode) throw new Error('Stop the active turn before changing chat/work permissions.');
      if (!state.busy && await api.setToolMode(toolMode) !== toolMode) throw new Error('Mixdog could not apply chat/work permissions.');
      if (signal?.aborted) throw new Error('Session attachment cancelled.');
      const entry = { api, viewId: args.viewId, sessionId, model, mode: args.mode, turn: null, unsubscribe: null, handoffPending: false };
      entry.unsubscribe = api.subscribe(() => publish(entry));
      views.set(args.viewId, entry);
      return snapshot(checked(entry), entry.mode);
    } catch (error) {
      await api.dispose();
      throw error;
    }
  }
  async function close(id) {
    const entry = views.get(id);
    if (!entry) return true;
    views.delete(id);
    const turn = entry.turn;
    if (turn) turn.cancelRequested = true;
    try { await turn?.submission; }
    catch (error) {
      if (!/cancelled before prompt submission/.test(error.message)) throw error;
    }
    entry.unsubscribe();
    if (turn && entry.turn === turn && turn.dispatched && checked(entry).busy) await entry.api.abortAsync();
    await entry.api.dispose();
    return true;
  }
  async function structuredText(args, signal) {
    const model = await route(args.modelKey, args.effort);
    if (!args.schema || args.schema.type !== 'object') throw new TypeError('Structured text requires an object schema.');
    const api = await createSession({
      cwd, provider: model.provider, model: model.model, effort: args.effort || undefined, toolMode: 'none',
      desktopSession: await bloomMetadata('structured-text', compactSessionTitle(args.text)),
    });
    let unsubscribe = () => {};
    let timer;
    let abort;
    try {
      if (await api.setToolMode('none') !== 'none') throw new Error('Mixdog could not disable tools.');
      const sessionId = api.getState().sessionId;
      const completed = new Promise((resolveDone, reject) => {
        const inspect = () => {
          const state = api.getState();
          if (state.sessionId !== sessionId || state.provider !== model.provider || state.model !== model.model)
            return reject(new Error('Structured request session/model identity changed.'));
          if (state.userQuestion || state.toolApproval) return reject(new Error('No-tools text request unexpectedly requested user interaction.'));
          const done = array(state.items).findLast((row) => row.kind === 'turndone');
          if (!done) return;
          if (done.status !== 'done') return reject(new Error(done.detail || `Text request ${done.status}`));
          const answer = array(state.items).filter((row) => row.kind === 'assistant').map((row) => row.text || '').join('\n');
          try {
            const value = JSON.parse(answer);
            const error = schemaValueError(value, args.schema, 'structured response');
            if (error) throw new Error(error);
            resolveDone(value);
          } catch (error) { reject(error); }
        };
        unsubscribe = api.subscribe(inspect);
        timer = setTimeout(() => reject(new Error('Structured text request timed out.')), 120_000);
        abort = () => reject(new Error('Structured text request cancelled.'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      // Handle cancellation/error even while prompt intake is still pending.
      completed.catch(() => {});
      if (signal?.aborted) throw new Error('Structured text request cancelled.');
      const prompt = `${text(args.system)}\n\nReturn only a JSON object matching this schema. Do not use tools or perform actions.\n${JSON.stringify(args.schema)}\n\nInput:\n${text(args.text)}`;
      if (!await api.submitAsync(prompt, { id: `bloom-text-${randomUUID()}` })) throw new Error('Structured text request was rejected.');
      return await completed;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      unsubscribe();
      if (api.getState().busy) await api.abortAsync();
      await api.dispose();
    }
  }
  return {
    async call(method, args = {}, { signal, acceptHandoff } = {}) {
      switch (method) {
        case 'models': return models();
        case 'usage': return sanitizeBloomUsage(await (await gateway()).getUsageDashboard({ refresh: false }));
        case 'sessions': return array(await (await gateway()).listSessions()).map((row) => ({
          sessionId: text(row.sessionId) || text(row.id), title: text(row.title), cwd: text(row.cwd),
          provider: text(row.provider), model: text(row.model),
          ...(bloomSessionPurpose(row.desktopSession) ? {
            source: 'bloom', purpose: row.desktopSession.purpose, projectPath: row.desktopSession.projectPath,
          } : {}),
        }));
        case 'previewSessions': {
          const api = await gateway();
          const metadata = await bloomMetadata('chat');
          return previewBloomSessionChanges(await api.listSessions(), {
            projectPath: metadata.projectPath, links: args.links, manualTitles: args.manualTitles,
          });
        }
        case 'session': {
          const state = await (await gateway()).readSessionSnapshot(args.sessionId);
          if (state.sessionId !== args.sessionId) throw new Error('Session read returned another identity.');
          return snapshot(state, ['none', 'questions'].includes(state.toolMode) ? 'chat' : 'work');
        }
        case 'search': {
          const api = await gateway();
          const projects = array(await api.listProjects()).map((row) => ({ path: text(row.path), name: text(row.name) }));
          const mixdogText = await api.searchConversations(args.query, { limit: args.limit });
          return { projects, mixdogText: text(mixdogText), bloomChats: [] };
        }
        case 'open': return open(args, signal);
        case 'close': return close(args.viewId);
        case 'structuredText': return structuredText(args, signal);
        case 'send': {
          const entry = view(args.viewId);
          const state = checked(entry);
          if (entry.turn || state.busy || entry.handoffPending) throw new Error('Mixdog session is already busy.');
          if (state.toolMode !== modeFor(entry.mode)) throw new Error('Mixdog tool permissions changed; re-open this session explicitly.');
          if (!text(args.turnId)) throw new TypeError('A turn identity is required.');
          const turn = {
            id: args.turnId, terminalBefore: array(state.items).findLast((item) => item.kind === 'turndone')?.id,
            cancelRequested: false, dispatched: false, submission: null,
          };
          entry.turn = turn;
          let accepted = false;
          turn.submission = (async () => {
            await route(entry.model.key, args.effort);
            const prompt = await makePrompt(args.text, args.images);
            if (entry.turn !== turn || turn.cancelRequested || signal?.aborted) throw new Error('Message cancelled before prompt submission.');
            turn.dispatched = true;
            accepted = await entry.api.submitAsync(prompt, { id: turn.id });
            if (entry.turn === turn) publish(entry);
            if (!accepted) throw new Error('Mixdog rejected the message.');
            return true;
          })();
          try { return await turn.submission; }
          finally {
            turn.submission = null;
            if (entry.turn === turn && !accepted && (!turn.dispatched || !entry.api.getState().busy)) entry.turn = null;
          }
        }
        case 'cancel': {
          const entry = view(args.viewId);
          checked(entry);
          const turn = entry.turn;
          if (!turn || args.turnId !== turn.id) throw new Error('Cancellation belongs to another turn.');
          turn.cancelRequested = true;
          // Cancellation of pending attachment/image intake must not be followed
          // by a delayed paid prompt. A submitted turn is aborted after intake.
          try { await turn.submission; }
          catch (error) {
            if (!/cancelled before prompt submission/.test(error.message)) throw error;
          }
          if (entry.turn !== turn) return { aborted: false };
          const result = await entry.api.abortAsync();
          if (entry.turn === turn) entry.turn = null;
          return result;
        }
        case 'answer': {
          const entry = view(args.viewId);
          const state = checked(entry);
          if (state.userQuestion?.id !== args.questionId || state.userQuestion.sessionId !== entry.sessionId)
            throw new Error('User question is no longer pending in this session.');
          return entry.api.resolveUserQuestion(args.questionId, normalizeUserQuestionResponse(args.response));
        }
        case 'approve': {
          const entry = view(args.viewId);
          const state = checked(entry);
          if (entry.mode !== 'work') throw new Error('Plain chat cannot approve execution. Enter work mode explicitly.');
          if (state.toolApproval?.id !== args.approvalId) throw new Error('Execution approval is no longer pending.');
          return entry.api.approveAsync(args.approvalId, { approved: args.allow === true });
        }
        case 'handoff': {
          const entry = view(args.viewId);
          signal?.throwIfAborted();
          if (args.sessionId && args.sessionId !== entry.sessionId) throw new Error('Handoff addresses another session.');
          if (checked(entry).busy || entry.turn || entry.handoffPending) throw new Error('Stop the active turn before handing off work.');
          const previousMode = entry.mode;
          entry.handoffPending = true;
          try {
            if (await entry.api.setToolMode('full') !== 'full') throw new Error('Mixdog could not enter work mode.');
            entry.mode = 'work';
            signal?.throwIfAborted();
            const result = await entry.api.handoff({ signal });
            signal?.throwIfAborted();
            if (result.sessionId !== entry.sessionId) throw new Error('Handoff returned another session.');
            const handoff = { sessionId: entry.sessionId, cwd: result.cwd, mode: 'work' };
            if (acceptHandoff) await acceptHandoff(handoff);
            signal?.throwIfAborted();
            publish(entry);
            return handoff;
          } catch (error) {
            if (previousMode === 'chat') {
              try {
                if (await entry.api.setToolMode('questions') !== 'questions') throw new Error('Question-only permission rollback was rejected.');
                entry.mode = 'chat';
                publish(entry);
              } catch (rollbackError) {
                throw new Error(`${error.message} Work-mode permission rollback also failed: ${rollbackError.message}`);
              }
            }
            throw error;
          } finally {
            entry.handoffPending = false;
          }
        }
        default: throw new Error(`Unknown Bloom bridge method: ${method}`);
      }
    },
    async dispose() {
      await Promise.all([...views.keys()].map(close));
      if (gatewayPromise) await (await gatewayPromise).dispose();
    },
  };
}

/** The JSONL delivery owner survives stdout enqueue until Bloom accepts the
 * exact proposal. No acceptance within 30s, caller cancel or input/output loss
 * aborts the same handoff and runs its existing permission rollback. */
export function serveBloomBridge({ bridge, input, output, acceptanceTimeoutMs = 30_000 }) {
  const pending = new Map();
  const reader = createInterface({ input, crlfDelay: Infinity });
  const stopped = Promise.withResolvers();
  let stopping = false;
  const write = (value) => {
    try {
      output.write(`${JSON.stringify(value)}\n`, (error) => { if (error) stop(error, error); });
    } catch (error) { stop(error, error); }
  };
  function stop(reason = new Error('Bloom bridge disconnected before delivery acceptance.'), failure = null) {
    if (stopping) return stopped.promise;
    stopping = true;
    reader.close();
    for (const entry of pending.values()) if (!entry.accepted) entry.controller.abort(reason);
    void Promise.all([...pending.values()].map((entry) => entry.task))
      .then(() => bridge.dispose())
      .then(() => {
        input.off('error', inputError);
        output.off('error', outputError);
        if (failure) stopped.reject(failure);
        else stopped.resolve();
      }, stopped.reject);
    return stopped.promise;
  }
  const inputError = (error) => { void stop(error, error); };
  const outputError = (error) => { void stop(error, error); };
  input.on('error', inputError);
  output.on('error', outputError);
  reader.on('line', (line) => {
    if (stopping) return;
    let request;
    try { request = JSON.parse(line); }
    catch { write({ error: 'Invalid Bloom bridge JSON.' }); return; }
    const entry = pending.get(request.args?.id);
    if (request.method === '$cancel') {
      if (entry && !entry.accepted) entry.controller.abort(new Error('Bloom cancelled before delivery acceptance.'));
      return;
    }
    if (request.method === '$accept') {
      if (!entry || entry.accepted || entry.controller.signal.aborted || !entry.proposal ||
          request.args.acceptanceToken !== entry.proposal.token || request.args.sessionId !== entry.proposal.result.sessionId) return;
      if (Date.now() >= entry.proposal.expiresAt) {
        entry.controller.abort(new Error('Bloom handoff delivery acceptance expired.'));
        return;
      }
      entry.accepted = true;
      entry.proposal.resolve();
      return;
    }
    if (typeof request.id !== 'string' || !request.id || pending.has(request.id)) {
      write({ id: request.id, error: 'A unique Bloom request identity is required.' });
      return;
    }
    const call = { controller: new AbortController(), accepted: false, proposal: null, task: null };
    pending.set(request.id, call);
    call.task = bridge.call(request.method, request.args || {}, {
      signal: call.controller.signal,
      acceptHandoff: async (result) => {
        const receipt = Promise.withResolvers();
        const token = randomUUID();
        const expiresAt = Date.now() + acceptanceTimeoutMs;
        call.proposal = { result, token, expiresAt, resolve: receipt.resolve };
        const abort = () => receipt.reject(call.controller.signal.reason);
        const timer = setTimeout(() => {
          if (!call.accepted) call.controller.abort(new Error('Bloom did not accept handoff delivery before expiry.'));
        }, acceptanceTimeoutMs);
        call.controller.signal.addEventListener('abort', abort, { once: true });
        try {
          if (call.controller.signal.aborted) abort();
          else write({ id: request.id, result, acceptanceToken: token, acceptanceExpiresAt: expiresAt });
          await receipt.promise;
        } finally {
          clearTimeout(timer);
          call.controller.signal.removeEventListener('abort', abort);
        }
      },
    }).then((result) => {
      if (!stopping) write({
        id: request.id, result,
        ...(call.accepted ? { accepted: true, acceptanceToken: call.proposal.token } : {}),
      });
    }).catch((error) => {
      if (!stopping) write({ id: request.id, error: safeErrorDetails(error.message), code: text(error.code) });
    }).finally(() => pending.delete(request.id));
  });
  reader.on('close', () => { void stop(); });
  return { closed: stopped.promise, close: stop, get pendingCount() { return pending.size; } };
}

async function main() {
  const { attachSession, readSessionDiscovery, probeSessionHealth } = await import('./session-client.mjs');
  const { createSessionProxyFactory } = await import('./session-proxy.mjs');
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const createSession = createSessionProxyFactory({
    // Discovery only. Bloom must never start, upgrade or restart the user's app/daemon.
    ensureDaemon: async () => {
      const discovery = readSessionDiscovery();
      if (!discovery) throw new Error('Mixdog Personal is not running or its session bridge is unavailable.');
      requireBloomRuntime(await probeSessionHealth(discovery));
      return discovery;
    },
    attachSession: (options) => attachSession({
      ...options, lifecycle: false,
      onStreamDisconnect: () => write({ event: 'connection', status: 'reconnecting' }),
      onStreamReconnect: () => write({ event: 'connection', status: 'connected' }),
      onFatal: (reason) => {
        write({ event: 'connection', status: 'disconnected', error: safeErrorDetails(reason) });
        options.onFatal(reason);
      },
    }),
  });
  const bridge = createBloomBridge({ createSession, emit: write });
  await serveBloomBridge({ bridge, input: process.stdin, output: process.stdout }).closed;
  process.exitCode = 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { process.stderr.write(`${safeErrorDetails(error.message)}\n`); process.exitCode = 1; });
