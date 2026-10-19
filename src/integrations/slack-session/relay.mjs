import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SLACK_HELP, approvalText, parseSlackControl, questionResponse, questionText, rotationReason, statusText } from './controls.mjs';
import { SLACK_PROJECT_CWD } from './project.mjs';
import { slackWorkspace } from '../../runtime/shared/slack-execution-policy.mjs';

export class SlackMixdogRelay {
  constructor({ config, store, transport, api, postMessage, authorize, extractPrompt, resolveIdentity, loadAttachments, chunkText, log = () => {}, now = Date.now }) {
    Object.assign(this, { config, store, transport, api, postMessage, authorize, extractPrompt, resolveIdentity, loadAttachments, chunkText, log, now });
    this.chains = new Map();
    this.latest = new Map();
    this.channelChains = new Map();
    this.channelTimes = new Map();
    this.closed = false;
    transport.on('state', ({ sessionId, state }) => {
      this.latest.set(sessionId, state);
      for (const [key, conversation] of store.listConversations()) {
        if (conversation.nativeSessionId === sessionId) {
          void this.serial(key, () => this.processState(key, state)).catch((error) => this.log(error.message));
        }
      }
    });
    transport.on('offline', (error) => this.log(`Mixdog 연결 중단: ${error.message}; 다음 점검에서 기존 세션에 재연결합니다.`));
  }

  serial(key, operation) {
    const result = (this.chains.get(key) || Promise.resolve()).then(operation);
    this.chains.set(key, result.catch(() => {}));
    return result;
  }

  async save(key, conversation) {
    const write = (this.writeChain || Promise.resolve()).then(() => this.store.setConversation(key, conversation));
    this.writeChain = write.catch(() => {});
    await write;
  }

  key(message) {
    return `slack:${message.team}:${message.channel}:${message.thread_ts || message.ts}:${message.user}`;
  }

  async start() {
    await this.store.load();
    for (const [key, conversation] of this.store.listConversations()) {
      if (!Array.isArray(conversation.queue) || !Array.isArray(conversation.outbox) || !conversation.requests) {
        throw new Error('Mixdog 상태 파일 형식이 다릅니다. 기존 기록을 덮어쓰지 않습니다.');
      }
      for (const item of conversation.outbox) if (item.status === 'posting') item.status = 'uncertain';
      await this.save(key, conversation);
    }
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((error) => this.log(error.message)), this.config.pollIntervalMs);
    this.timer.unref?.();
  }

  fresh(identity) {
    return {
      ...this.api.createConversation(identity),
      nativeSessionId: '',
      requests: {},
      queue: [],
      activeRequestId: null,
      outbox: [],
      seenMessageIds: [],
      notices: [],
      context: null,
      needsStop: false,
    };
  }

  async handleMessage(message, botUserId) {
    if (!this.authorize(message) || message.user === botUserId) return false;
    const key = this.key(message);
    const existing = this.store.getConversation(key);
    const prompt = this.extractPrompt(message, botUserId, Boolean(existing));
    if (prompt === null) return false;
    return this.serial(key, async () => {
      let conversation = this.store.getConversation(key);
      if (!conversation) {
        const identity = {
          teamId: message.team, channelId: message.channel, threadTs: message.thread_ts || message.ts,
          userId: message.user, userName: await this.resolveIdentity(message.user),
        };
        conversation = this.fresh(identity);
      }
      if (conversation.seenMessageIds.includes(message.ts)) return true;
      conversation.seenMessageIds.push(message.ts);
      await this.save(key, conversation);
      const event = `event:${message.ts}`;
      try {
        if (!prompt.trim()) throw new Error('프롬프트를 입력하거나 !help를 사용하세요.');
        const command = parseSlackControl(prompt, this.api.parseNewSessionCommand);
        if (command) {
          await this.control(key, conversation, command, event);
        } else {
          const current = conversation.nativeSessionId
            ? (await this.transport.request('open', { sessionId: conversation.nativeSessionId })).state
            : null;
          if (current?.userQuestion) {
            await this.answer(key, conversation, current.userQuestion.id, prompt);
            await this.message(key, conversation, `${event}:answer`, '✅ 답변을 같은 Mixdog 세션에 전달했습니다.');
          } else {
            if (prompt.length > this.config.maxPromptChars) throw new Error(`프롬프트는 최대 ${this.config.maxPromptChars}자입니다.`);
            if (conversation.queue.length >= this.config.maxTurns) throw new Error('대기 요청이 가득 찼습니다. !status 또는 !stop을 사용하세요.');
            const files = await this.loadAttachments(message.files || []);
            const staged = files.length ? (await this.transport.request('stageFiles', {
              files, principal: { teamId: conversation.teamId, userId: conversation.actorId },
            })).files : [];
            const id = `slack:${message.channel}:${message.ts}`;
            const marker = `[Slack request ${id}]`;
            conversation.requests[id] = {
              id, marker, prompt, userId: message.user,
              userName: await this.resolveIdentity(message.user),
              files: staged, status: 'queued', createdAt: this.now(),
              deadline: this.now() + this.config.timeoutMs,
            };
            conversation.queue.push(id);
            await this.save(key, conversation);
            await this.message(key, conversation, `${event}:queued`, `📥 Mixdog 요청을 접수했습니다. 대기 ${conversation.queue.length}건.`);
            await this.pump(key, conversation);
          }
        }
      } catch (error) {
        await this.message(key, conversation, `${event}:error`, `❌ ${error.message}`);
      }
      return true;
    });
  }

  async observeDelivery(message, botUserId) {
    if (message.user !== botUserId || message.metadata?.event_type !== 'mixdog_slack_bridge') return false;
    const deliveryId = message.metadata.event_payload?.delivery_id;
    const match = this.store.listConversations().find(([, conversation]) =>
      conversation.teamId === message.team && conversation.channelId === message.channel
      && conversation.threadTs === (message.thread_ts || message.ts)
      && conversation.outbox.some((item) => item.id === deliveryId)
    );
    if (!match) return false;
    const [key] = match;
    return this.serial(key, async () => {
      const conversation = this.store.getConversation(key);
      const item = conversation.outbox.find((entry) => entry.id === message.metadata.event_payload?.delivery_id);
      if (!item || item.status === 'sent' || item.status === 'cancelled') return true;
      item.status = 'sent';
      item.ts = message.ts;
      await this.save(key, conversation);
      const state = this.latest.get(conversation.nativeSessionId);
      if (state) await this.processState(key, state);
      return true;
    });
  }

  async control(key, conversation, command, event) {
    if (command.type === 'help' || command.type === 'invalid') {
      await this.message(key, conversation, `${event}:help`, SLACK_HELP);
      return;
    }
    if (command.type === 'retry') {
      for (const item of conversation.outbox) {
        if (['failed', 'uncertain'].includes(item.status)) item.status = 'pending';
      }
      await this.save(key, conversation);
      await this.flush(key, conversation);
      const state = this.latest.get(conversation.nativeSessionId);
      if (state) await this.processState(key, state);
      return;
    }
    if (command.type === 'stop' || command.type === 'new') {
      await this.stop(key, conversation);
      if (command.type === 'new') conversation = await this.rotate(key, conversation, command.clear, 'manual');
      await this.message(key, conversation, `${event}:${command.type}`, command.type === 'new'
        ? `🆕 Mixdog 새 세션으로 전환했습니다. ${command.clear ? '이전 맥락은 넘기지 않습니다.' : '제한된 이전 요약만 이관합니다.'} 기록은 보존했습니다.`
        : '⏹️ 이 스레드의 주실행과 대기 입력을 중단했습니다. 분리된 백그라운드 작업은 Mixdog에서 별도로 확인하세요.');
      return;
    }
    if (!conversation.nativeSessionId) {
      if (command.type !== 'status') throw new Error('현재 스레드에 실행 중인 Mixdog 세션이 없습니다.');
    }
    const state = conversation.nativeSessionId
      ? (await this.transport.request('open', { sessionId: conversation.nativeSessionId })).state
      : null;
    if (command.type === 'status') {
      if (state) conversation.context = await this.transport.request('context', { sessionId: conversation.nativeSessionId });
      await this.message(key, conversation, `${event}:status`, statusText(conversation, state, conversation.context, this.config));
    } else if (command.type === 'approve') {
      if (!state.toolApproval || state.toolApproval.id !== command.id) throw new Error('이 스레드의 현재 승인 ID가 아닙니다.');
      const result = await this.transport.request('approve', {
        sessionId: conversation.nativeSessionId, approvalId: command.id, approved: command.approved,
      });
      if (!result.accepted) throw new Error('승인 요청이 만료되었거나 이미 처리됐습니다.');
      await this.message(key, conversation, `${event}:approval`, command.approved ? '✅ 명시적 승인을 전달했습니다.' : '⛔ 거절을 전달했습니다.');
    } else if (command.type === 'answer') {
      await this.answer(key, conversation, command.id, command.text);
      await this.message(key, conversation, `${event}:answer`, '✅ 답변을 같은 Mixdog 세션에 전달했습니다.');
    }
  }

  async answer(key, conversation, id, text) {
    const state = (await this.transport.request('state', { sessionId: conversation.nativeSessionId })).state;
    if (!state.userQuestion || state.userQuestion.id !== id) throw new Error('이 스레드의 현재 질문 ID가 아닙니다.');
    const result = await this.transport.request('answer', {
      sessionId: conversation.nativeSessionId, questionId: id,
      response: questionResponse(state.userQuestion, text),
    });
    if (!result.accepted) throw new Error('질문이 만료되었거나 이미 처리됐습니다.');
    await this.save(key, conversation);
  }

  async stop(key, conversation, reason = 'stopped') {
    for (const id of [...conversation.queue, conversation.activeRequestId].filter(Boolean)) {
      conversation.requests[id].status = reason;
      for (const item of conversation.outbox) {
        if (item.key.startsWith(`reply:${id}:`) && item.status !== 'sent') item.status = 'cancelled';
      }
    }
    conversation.queue = [];
    conversation.activeRequestId = null;
    conversation.needsStop = Boolean(conversation.nativeSessionId);
    await this.save(key, conversation);
    if (conversation.nativeSessionId) {
      await this.transport.request('open', { sessionId: conversation.nativeSessionId });
      await this.transport.request('abort', { sessionId: conversation.nativeSessionId });
    }
    conversation.needsStop = false;
    await this.save(key, conversation);
  }

  async rotate(key, conversation, clear, reason) {
    const previous = conversation.nativeSessionId;
    const next = {
      ...this.api.rotateConversation(conversation, {
        userId: conversation.actorId, userName: conversation.userName,
        teamId: conversation.teamId, channelId: conversation.channelId, threadTs: conversation.threadTs,
      }, this.config.conversationLimits, { clear, reason }),
      nativeSessionId: '', requests: conversation.requests, queue: conversation.queue,
      nativeSessionHistory: [...new Set([...(conversation.nativeSessionHistory || []), previous].filter(Boolean))],
      sessionTitle: conversation.sessionTitle,
      activeRequestId: null, outbox: conversation.outbox, seenMessageIds: conversation.seenMessageIds,
      notices: [], context: null, needsStop: false,
    };
    await this.save(key, next);
    next.sessionTitle ||= next.queue.length ? next.requests[next.queue[0]].prompt : '새 작업';
    const opened = await this.transport.request('open', { userName: next.userName, title: next.sessionTitle,
      principal: { teamId: next.teamId, userId: next.actorId } });
    next.nativeSessionId = opened.sessionId;
    this.latest.set(opened.sessionId, opened.state);
    await this.save(key, next);
    if (previous) await this.transport.request('release', { sessionId: previous });
    return next;
  }

  promptFor(conversation, request) {
    return [
      request.marker,
      `승인된 Slack 요청자: ${request.userName} (${request.userId})`,
      `Slack 대화: ${conversation.channelId}/${conversation.threadTs}`,
      `논리 세션: ${conversation.logicalSessionId}`,
      `새 산출물 기본 경로: ${slackWorkspace({ root: SLACK_PROJECT_CWD, teamId: conversation.teamId, userId: conversation.actorId })}`,
      conversation.turnCount === 0 && conversation.summary
        ? `\n[이전 세션 참고 요약 — 현재 요청과 관련된 부분만 사용]\n${conversation.summary}` : '',
      '\n[현재 사용자 요청]', request.prompt,
      request.files.length ? '\n[사용자가 이 요청에 첨부한 파일 — 필요한 경우 해당 파일을 읽어 확인하세요.]' : '',
      ...request.files.map((file) => `- ${file.name}: ${file.path}`),
    ].filter(Boolean).join('\n');
  }

  async pump(key, conversation) {
    if (this.closed || conversation.needsStop || conversation.activeRequestId || !conversation.queue.length) return;
    if (conversation.outbox.some((item) => !['sent', 'cancelled'].includes(item.status))) return;
    const request = conversation.requests[conversation.queue[0]];
    if (request.deadline <= this.now()) {
      conversation.queue.shift();
      request.status = 'timeout';
      await this.message(key, conversation, `reply:${request.id}:timeout`, '⌛ 대기 요청이 만료되어 자동 실행하지 않았습니다. 다시 요청해 주세요.');
      await this.save(key, conversation);
      return this.pump(key, conversation);
    }
    if (!conversation.nativeSessionId) {
      conversation.sessionTitle = request.prompt;
      const opened = await this.transport.request('open', { userName: conversation.userName, title: conversation.sessionTitle,
        principal: { teamId: conversation.teamId, userId: conversation.actorId } });
      conversation.nativeSessionId = opened.sessionId;
      this.latest.set(opened.sessionId, opened.state);
      await this.save(key, conversation);
    }
    let fullPrompt = this.promptFor(conversation, request);
    let context = await this.transport.request('context', { sessionId: conversation.nativeSessionId, prompt: fullPrompt });
    const reason = rotationReason(conversation, context, this.config.maxTurns);
    if (reason && conversation.turnCount > 0) {
      conversation = await this.rotate(key, conversation, false, reason);
      await this.message(key, conversation, `rotation:${conversation.generation}`, `🔄 ${reason === 'turn-limit' ? '턴 제한' : '모델 입력 예산'}에 따라 새 세션으로 전환했습니다. 제한된 요약만 이관합니다.`);
      fullPrompt = this.promptFor(conversation, request);
      context = await this.transport.request('context', { sessionId: conversation.nativeSessionId, prompt: fullPrompt });
    }
    if (rotationReason({ turnCount: 0 }, context, this.config.maxTurns)) {
      conversation.queue.shift();
      request.status = 'error';
      await this.message(key, conversation, `reply:${request.id}:too-large`, '❌ 새 세션의 입력 예산도 초과합니다. 요청 또는 첨부 내용을 줄여 주세요.');
      await this.save(key, conversation);
      return;
    }
    conversation.queue.shift();
    conversation.activeRequestId = request.id;
    request.status = 'submitting';
    request.sessionId = conversation.nativeSessionId;
    request.generation = conversation.generation;
    request.fullPrompt = fullPrompt;
    conversation.context = context;
    await this.save(key, conversation);
    let result;
    try {
      result = await this.transport.request('submit', {
        sessionId: request.sessionId, prompt: fullPrompt, requestId: request.id,
      });
      if (!result.accepted) throw new Error('Mixdog가 입력을 접수하지 않았습니다.');
    } catch (error) {
      // An uncertain submission is never replayed automatically.
      request.status = 'uncertain';
      await this.save(key, conversation);
      await this.message(key, conversation, `submit-error:${request.id}`, `⚠️ 접수 상태 확인이 필요합니다. 자동 재실행하지 않습니다: ${error.message}`);
      return;
    }
    request.status = 'running';
    await this.save(key, conversation);
    await this.message(key, conversation, `start:${request.id}`, `🚀 Mixdog가 작업을 시작했습니다. 턴 ${conversation.turnCount + 1}/${this.config.maxTurns}`);
    await this.processState(key, result.state);
  }

  async processState(key, state) {
    let conversation = this.store.getConversation(key);
    if (!conversation || state.sessionId !== conversation.nativeSessionId) return;
    this.latest.set(state.sessionId, state);
    const request = conversation.requests[conversation.activeRequestId];
    if (!request || request.sessionId !== state.sessionId || request.generation !== conversation.generation) return;
    if (state.toolApproval && !conversation.notices.includes(`approval:${state.toolApproval.id}`)) {
      conversation.notices.push(`approval:${state.toolApproval.id}`);
      await this.message(key, conversation, `approval:${state.toolApproval.id}`, approvalText(state.toolApproval));
    }
    if (state.userQuestion && !conversation.notices.includes(`question:${state.userQuestion.id}`)) {
      conversation.notices.push(`question:${state.userQuestion.id}`);
      await this.message(key, conversation, `question:${state.userQuestion.id}`, questionText(state.userQuestion));
    }
    const user = state.items.find((item) => item.kind === 'user'
      && (request.nativeMessageId ? item.messageId === request.nativeMessageId : item.text?.startsWith(request.marker)));
    if (!user) {
      if (request.status === 'submitting' || request.status === 'uncertain') await this.save(key, conversation);
      return;
    }
    request.nativeMessageId = user.messageId;
    if (request.status === 'uncertain' || request.status === 'submitting') request.status = 'running';
    const done = state.items.find((item) => item.kind === 'turndone' && item.checkpointId === user.id);
    if (!done) {
      await this.save(key, conversation);
      return;
    }
    const from = state.items.indexOf(user);
    const to = state.items.indexOf(done);
    const answers = state.items.slice(from + 1, to).filter((item) => item.kind === 'assistant' && item.text?.trim());
    if (done.status === 'done' && answers.length) {
      for (const answer of answers) await this.message(key, conversation, `reply:${request.id}:${answer.messageId || answer.id}`, answer.text);
      conversation.context = await this.transport.request('context', { sessionId: state.sessionId });
      await this.message(key, conversation, `reply:${request.id}:status`, statusText({
        ...conversation, turnCount: conversation.turnCount + 1, activeRequestId: null,
      }, state, conversation.context, this.config));
    } else {
      const error = state.items.slice(from + 1, to).filter((item) => item.kind === 'error').map((item) => item.text).join('\n');
      await this.message(key, conversation, `reply:${request.id}:error`, `❌ ${done.status === 'done' ? 'Mixdog가 최종 답변 없이 종료했습니다.' : `Mixdog 실행이 ${done.status} 상태로 종료됐습니다.`}${error ? `\n${error}` : ''}`);
    }
    const replies = conversation.outbox.filter((item) => item.key.startsWith(`reply:${request.id}:`));
    if (replies.some((item) => item.status !== 'sent')) {
      await this.save(key, conversation);
      return;
    }
    request.status = done.status === 'done' && answers.length ? 'done' : 'error';
    if (request.status === 'done') {
      conversation = this.api.appendConversationTurn(conversation, {
        user: request.prompt, assistant: answers.map((item) => item.text).join('\n\n'),
        at: new Date(this.now()).toISOString(), model: state.model,
      }, this.config.conversationLimits);
    }
    conversation.activeRequestId = null;
    await this.save(key, conversation);
    await this.pump(key, conversation);
  }

  async message(key, conversation, messageKey, text) {
    const chunks = this.chunkText(text);
    for (const [index, chunk] of chunks.entries()) {
      const part = `${messageKey}:${index}`;
      if (conversation.outbox.some((item) => item.key === part)) continue;
      conversation.outbox.push({
        key: part,
        id: createHash('sha256').update(`${key}\0${part}`).digest('hex'),
        text: chunk, status: 'pending',
      });
    }
    await this.save(key, conversation);
    await this.flush(key, conversation);
  }

  async flush(key, conversation) {
    let blocked = false;
    for (const item of conversation.outbox) {
      if (item.status === 'cancelled' || item.status === 'sent') continue;
      if (item.status !== 'pending' || (item.retryAt || 0) > this.now()) {
        blocked = true;
        continue;
      }
      // Operator commands must remain usable when a previous reply has an
      // uncertain delivery. Reply chunks themselves must retain their order.
      if (blocked && item.key.startsWith('reply:')) continue;
      item.status = 'posting';
      await this.save(key, conversation);
      const channel = conversation.channelId;
      const send = (this.channelChains.get(channel) || Promise.resolve()).then(async () => {
        const delay = (this.channelTimes.get(channel) || 0) - this.now();
        if (delay > 0) await sleep(delay);
        this.channelTimes.set(channel, this.now() + this.config.messageIntervalMs);
        return this.postMessage({
          channel, thread_ts: conversation.threadTs, text: item.text,
          metadata: { event_type: 'mixdog_slack_bridge', event_payload: { delivery_id: item.id } },
          unfurl_links: false, unfurl_media: false,
        });
      });
      this.channelChains.set(channel, send.catch(() => {}));
      try {
        const result = await send;
        if (!result.ok) throw Object.assign(new Error(result.error || 'Slack 전송 실패'), { data: result });
        item.status = 'sent';
        item.ts = result.ts;
      } catch (error) {
        item.error = String(error.message);
        if (Number(error.retryAfter) > 0) {
          item.status = 'pending';
          item.retryAt = this.now() + Number(error.retryAfter) * 1000;
        } else {
          item.status = error.data?.ok === false ? 'failed' : 'uncertain';
        }
        this.log(`Slack 전송 ${item.status}: ${item.error}`);
      }
      await this.save(key, conversation);
      if (item.status !== 'sent') blocked = true;
    }
  }

  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      // The hub must reconnect even when there are no pending Slack requests.
      try {
        await this.transport.start();
      } catch (error) {
        this.log(`Mixdog 준비 대기: ${error.message}`);
      }
      await Promise.all(this.store.listConversations().map(([key]) => this.serial(key, async () => {
        const conversation = this.store.getConversation(key);
        await this.flush(key, conversation);
        const request = conversation.requests[conversation.activeRequestId];
        if (request?.deadline <= this.now()) {
          await this.stop(key, conversation, 'timeout');
          await this.message(key, conversation, `timeout:${request.id}`, '⌛ Mixdog 요청 시간이 초과되어 주실행과 대기를 중단했습니다.');
          return;
        }
        if (conversation.nativeSessionId && request) {
          const opened = await this.transport.request('open', { sessionId: conversation.nativeSessionId });
          await this.processState(key, opened.state);
        } else {
          await this.pump(key, conversation);
        }
      }).catch((error) => this.log(`Mixdog 복구 대기: ${error.message}`))));
    } finally { this.ticking = false; }
  }

  async idle() {
    await Promise.all([...this.chains.values()]);
    await this.writeChain;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.idle();
    await this.transport.close();
  }
}
