import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  attachSession,
  probeSessionHealth,
  readSessionDiscovery,
  sessionDaemonCompatibility,
} from '../../standalone/session-client.mjs';
import { createSessionProxyFactory } from '../../standalone/session-proxy.mjs';
import { estimateTokens } from '../../runtime/agent/orchestrator/session/token-estimate.mjs';
import { redactToolCallArgumentsValue } from '../../runtime/agent/orchestrator/session/compact/text-utils.mjs';
import { normalizeUserQuestionResponse } from '../../runtime/user-questions/contract.mjs';
import { validateAskUserQuestions } from '../../runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs';
import { normalizeAskUserAnswers } from '../../session-runtime/internal-tool-executor/ask-user-tool.mjs';
import { SLACK_PROJECT_CWD } from './project.mjs';
import { projectHubState } from './hub/projection.mjs';
import { HubFiles } from './hub/files.mjs';
import { ApprovedJobRunner } from './approved-jobs.mjs';
import { slackSessionOwners } from './identity.mjs';
import { normalizeSlackExecutionPolicy, slackWorkspace, isPrivateSlackPath } from '../../runtime/shared/slack-execution-policy.mjs';

export function slackSessionState(state) {
  const questionApproval = state.toolApproval?.kind === 'question' ? state.toolApproval : null;
  const approval = questionApproval ? null : state.toolApproval;
  return {
    sessionId: state.sessionId,
    cwd: state.cwd,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    turnEffort: state.turnEffort,
    contextWindow: state.contextWindow,
    busy: state.busy === true,
    queued: (state.queued || []).map((entry) => ({ id: entry.id })),
    toolApproval: approval ? {
      id: approval.id,
      name: approval.name,
      args: redactToolCallArgumentsValue(approval.args),
      reason: redactToolCallArgumentsValue(approval.reason),
      cwd: approval.cwd,
      expiresAt: approval.expiresAt,
    } : null,
    userQuestion: state.userQuestion || (questionApproval ? {
      id: questionApproval.id,
      sessionId: state.sessionId,
      source: 'ask_user',
      questions: questionApproval.args.questions.map((question, index) => ({ ...question, id: `q${index + 1}` })),
    } : null),
    items: (state.items || []).filter((item) =>
      ['user', 'assistant', 'turndone', 'error'].includes(item.kind)
      && item.streaming !== true
      && item.channel !== 'analysis'
    ).map((item) => ({
      kind: item.kind,
      id: item.id,
      messageId: item.messageId,
      text: redactToolCallArgumentsValue(item.text),
      checkpointId: item.checkpointId,
      status: item.status,
      finalAssistantId: item.finalAssistantId,
    })),
  };
}

export class NativeSlackClient {
  constructor({ provider, model, effort, contextTokens, maxAttachmentBytes, onState, hubBridge, log = () => {} }) {
    this.options = { cwd: SLACK_PROJECT_CWD, provider, model, effort, contextTokens, toolMode: 'full', log };
    this.maxAttachmentBytes = maxAttachmentBytes;
    this.onState = onState;
    this.hubBridge = hubBridge;
    this.views = new Map();
    this.policies = new Map();
    this.hubFiles = new HubFiles(SLACK_PROJECT_CWD);
    this.signatures = new Map();
    this.createSession = createSessionProxyFactory({
      attachSession: (options) => attachSession({ ...options, lifecycle: false }),
      // Attaching a Slack bridge must never start, replace, or upgrade the user's daemon.
      ensureDaemon: () => this.discovery(),
    });
  }

  async discovery() {
    const discovery = readSessionDiscovery();
    if (!discovery) throw new Error('믹스독 앱이 실행 중인지 확인해 주세요.');
    const health = await probeSessionHealth(discovery);
    const compatibility = sessionDaemonCompatibility(health);
    if (!['compatible', 'daemon-newer'].includes(compatibility.status)) {
      throw new Error(`믹스독 세션 프로토콜이 호환되지 않습니다: ${compatibility.status}`);
    }
    return discovery;
  }

  async health() {
    await this.discovery();
    if (!this.existingSessionsSecured) {
      const conversations = await this.hubBridge.call('conversations');
      for (const row of slackSessionOwners(conversations.map(([, conversation]) => conversation))) {
        await this.open({ sessionId: row.id });
      }
      this.existingSessionsSecured = true;
    }
    return { ready: true };
  }

  emit(view) {
    const state = slackSessionState(view.getState());
    const signature = JSON.stringify(state);
    if (this.signatures.get(state.sessionId) === signature) return;
    this.signatures.set(state.sessionId, signature);
    this.onState({ sessionId: state.sessionId, state });
  }

  async open({ sessionId, userName, title, principal } = {}) {
    if (!sessionId && (typeof userName !== 'string' || !userName.trim() || typeof title !== 'string' || !title.trim())) {
      throw new TypeError('새 Slack 세션에는 사용자 이름과 작업 제목이 필요합니다.');
    }
    const policy = normalizeSlackExecutionPolicy(await this.hubBridge.call('executionAccess', { sessionId, principal }));
    if (!sessionId && !policy.active) throw new Error('승인된 Slack 사용자만 작업을 시작할 수 있습니다.');
    if (sessionId && this.views.has(sessionId)) {
      await this.restrict(this.view(sessionId), policy);
      return this.state({ sessionId });
    }
    const view = await this.createSession({ ...this.options, ...(sessionId ? { sessionId } : {}) });
    const state = view.getState();
    try {
      if (!state.sessionId) throw new Error('믹스독 세션 ID가 없습니다.');
      if (sessionId && state.sessionId !== sessionId) throw new Error('요청한 Slack 세션과 연결된 세션이 다릅니다.');
      if (state.provider !== this.options.provider || state.model !== this.options.model) {
        throw new Error('세션 모델이 Slack 설정과 다릅니다. !restart로 새 세션을 만들어 주세요.');
      }
      if (!sessionId) {
        const renamed = await view.renameSessionTitle(state.sessionId, `${userName} | ${title}`, { preservePrefix: true });
        if (!renamed) throw new Error('Slack 사용자 이름이 포함된 세션 제목을 저장하지 못했습니다.');
      }
      await this.restrict(view, policy);
    } catch (error) {
      await view.dispose();
      throw error;
    }
    this.views.set(state.sessionId, view);
    view.subscribe(() => this.emit(view));
    this.emit(view);
    return { sessionId: state.sessionId, state: slackSessionState(state) };
  }

  async restrict(view, policy) {
    const stored = await view.setSlackExecutionPolicy(policy);
    if (JSON.stringify(stored) !== JSON.stringify(policy)) throw new Error('Slack 실행 정책의 저장 결과가 일치하지 않습니다.');
    this.policies.set(view.getState().sessionId, policy);
  }

  view(sessionId) {
    const view = this.views.get(sessionId);
    if (!view) throw new Error('연결되지 않은 믹스독 세션입니다.');
    return view;
  }

  async state({ sessionId }) {
    const view = this.view(sessionId);
    await view.resume(sessionId);
    return { sessionId, state: slackSessionState(view.getState()) };
  }

  async submit({ sessionId, prompt, requestId }) {
    if (typeof prompt !== 'string' || !prompt.trim() || typeof requestId !== 'string' || !requestId) {
      throw new TypeError('prompt와 requestId가 필요합니다.');
    }
    await this.open({ sessionId });
    if (!this.policies.get(sessionId).active) throw new Error('Slack 사용자 승인이 해제되었습니다.');
    const view = this.view(sessionId);
    const accepted = await view.submitAsync(prompt, { id: requestId });
    return { accepted, state: slackSessionState(view.getState()) };
  }

  async context({ sessionId, prompt = '' }) {
    const context = await this.view(sessionId).contextStatus();
    return { ...context, nextPromptTokens: estimateTokens(prompt) };
  }

  async hubSnapshot({ sessionId }) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('세션 ID가 필요합니다.');
    await this.open({ sessionId });
    const view = this.view(sessionId);
    await view.resume(sessionId);
    const state = view.getState();
    if (path.relative(SLACK_PROJECT_CWD, state.cwd) !== '') throw new Error('SOFTON 외부 세션은 공유하지 않습니다.');
    const { producedPaths, ...snapshot } = projectHubState(state);
    const catalog = await view.listSessions({ includeClosed: true });
    snapshot.title = redactToolCallArgumentsValue(catalog.find((row) => row.id === sessionId)?.title || '');
    snapshot.files = await this.hubFiles.snapshot(sessionId, producedPaths);
    return snapshot;
  }

  async hubFile({ sessionId, fileId, sha256 }) {
    return this.hubFiles.file(sessionId, fileId, sha256);
  }

  async startHub({ origin, adminUsers, tlsKeyPath, tlsCertPath, documentsFile } = {}) {
    if (this.hub) throw new Error('공유실이 이미 실행 중입니다.');
    if (!this.hubBridge) throw new Error('공유실 Slack 승인 연결이 없습니다.');
    const [{ createSessionHub }, { runCloudWiki }] = await Promise.all([
      import('./hub/server.mjs'), import('../cloudwiki/bridge.mjs'),
    ]);
    if (origin?.startsWith('https:') && (!tlsKeyPath || !tlsCertPath)) throw new Error('Windows의 TLS 개인키·인증서 경로를 설정해 주세요.');
    const tls = origin?.startsWith('https:')
      ? { key: await fs.readFile(tlsKeyPath), cert: await fs.readFile(tlsCertPath) } : undefined;
    const jobRunner = new ApprovedJobRunner({
      createSession: (options) => this.createSession(options), options: this.options,
      access: (person) => this.hubBridge.call('executionAccess', { principal: person }),
    });
    const hub = await createSessionHub({
      origin, adminUsers, tls,
      documentsFile: documentsFile || path.join(os.homedir(), '.local/state/mixdog-slack-bridge/hub-documents.json'),
      store: { listConversations: () => this.hubBridge.call('conversations') },
      authorize: (message) => this.hubBridge.call('authorize', message),
      sendCode: (person, code) => this.hubBridge.call('sendCode', { person, code }),
      jobRunner,
      jobNotify: (job, event, inspect = false) => this.hubBridge.call('jobNotice', {
        jobId: job.id, sessionId: job.sessionId, teamId: job.teamId, userId: job.userId,
        event, inspect, summary: job.summary || '',
      }),
      transport: { request: (method, input) => {
        if (!['hubSnapshot', 'hubFile'].includes(method)) throw new Error('허용되지 않은 공유실 조회입니다.');
        return this[method](input);
      } },
      wiki: runCloudWiki, log: this.options.log,
    });
    const url = await hub.start();
    this.hub = hub;
    this.approvedJobRunner = jobRunner;
    return { origin: url };
  }

  async stopHub() {
    if (this.hub) await this.hub.close();
    this.hub = null;
    if (this.approvedJobRunner) await this.approvedJobRunner.close();
    this.approvedJobRunner = null;
    return { stopped: true };
  }

  async abort({ sessionId }) {
    const view = this.view(sessionId);
    const result = await view.abortAsync();
    return { aborted: result?.aborted === true, state: slackSessionState(view.getState()) };
  }

  async approve({ sessionId, approvalId, approved }) {
    await this.open({ sessionId });
    const policy = this.policies.get(sessionId);
    if (!policy.active || (approved === true && !policy.admin)) {
      throw new Error('일반 Slack 사용자는 도구 실행을 승인할 수 없습니다. PC의 Mixdog 관리자 승인 화면을 사용하세요.');
    }
    const view = this.view(sessionId);
    const pending = view.getState().toolApproval;
    if (!pending || pending.id !== approvalId) throw new Error('현재 세션의 승인 요청이 아닙니다.');
    if (typeof approved !== 'boolean') throw new TypeError('명시적인 승인 또는 거절이 필요합니다.');
    const accepted = await view.approveAsync(approvalId, {
      approved,
      reason: approved ? 'explicit Slack user approval' : 'explicit Slack user denial',
      device: 'Slack',
    });
    return { accepted };
  }

  async answer({ sessionId, questionId, response }) {
    await this.open({ sessionId });
    if (!this.policies.get(sessionId).active) throw new Error('Slack 사용자 승인이 해제되었습니다.');
    const view = this.view(sessionId);
    const state = view.getState();
    if (state.userQuestion?.id === questionId) {
      const accepted = await view.resolveUserQuestion(questionId, normalizeUserQuestionResponse(response));
      return { accepted };
    }
    const pending = state.toolApproval;
    if (pending?.kind !== 'question' || pending.id !== questionId) throw new Error('현재 세션의 질문이 아닙니다.');
    const questions = validateAskUserQuestions(pending.args);
    let decision;
    if (response?.cancelled === true) {
      normalizeUserQuestionResponse(response);
      decision = { approved: false, reason: 'dismissed by Slack user', device: 'Slack' };
    } else {
      const answers = normalizeAskUserAnswers(response?.answers, questions);
      if (!Array.isArray(response?.answers) || response.answers.length !== questions.length || answers.some((answer) => !answer)) {
        throw new TypeError('현재 질문 모두에 유효한 질문 응답을 전달해 주세요.');
      }
      decision = { approved: true, answers, device: 'Slack' };
    }
    const accepted = await view.approveAsync(questionId, decision);
    return { accepted };
  }

  async stageFiles({ files, principal }) {
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0);
    if (total > this.maxAttachmentBytes) throw new Error('첨부 파일 용량 제한을 초과했습니다.');
    const policy = normalizeSlackExecutionPolicy(await this.hubBridge.call('executionAccess', { principal }));
    if (!policy.active) throw new Error('승인된 Slack 사용자만 파일을 첨부할 수 있습니다.');
    const parent = path.join(slackWorkspace(policy), 'attachments');
    if (!isPrivateSlackPath(policy, parent)) throw new Error('첨부 파일 폴더가 사용자 작업 영역 밖을 가리킵니다.');
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, 'mixdog-slack-'));
    const staged = [];
    for (const file of files) {
      const name = path.basename(String(file.name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const target = path.join(directory, `${randomUUID()}-${name || 'attachment'}`);
      await fs.writeFile(target, Buffer.from(file.data, 'base64'), { mode: 0o600, flag: 'wx' });
      staged.push({ name: file.name, path: target, mimetype: file.mimetype });
    }
    return { files: staged };
  }

  async release({ sessionId }) {
    const view = this.views.get(sessionId);
    if (view) await view.dispose();
    this.views.delete(sessionId);
    this.signatures.delete(sessionId);
    this.hubFiles.manifests.delete(sessionId);
    return { released: true };
  }

  async close() {
    await this.stopHub();
    await Promise.all([...this.views.keys()].map((sessionId) => this.release({ sessionId })));
  }
}
