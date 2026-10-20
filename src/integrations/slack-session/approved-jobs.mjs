import fs from 'node:fs/promises';
import path from 'node:path';
import { HubFiles } from './hub/files.mjs';
import { projectHubState } from './hub/projection.mjs';
import { jobHandoff } from './hub/jobs.mjs';
import { redactToolCallArgumentsValue } from '../../runtime/agent/orchestrator/session/compact/text-utils.mjs';

// Only the authenticated hub controller calls this runner. It never upgrades a
// requester's Slack session and never starts a daemon or falls back to a shell.
export class ApprovedJobRunner {
  constructor({ createSession, options, access }) {
    this.createSession = createSession; this.options = options; this.access = access; this.views = new Map();
  }
  async administrator(person) {
    const policy = await this.access(person);
    if (policy?.active !== true || policy.admin !== true || policy.teamId !== person.teamId || policy.userId !== person.userId) {
      throw new Error('현재 관리자 승인이 필요합니다.');
    }
  }
  async project(job) {
    const real = await fs.realpath(job.projectPath);
    if (path.relative(job.projectPath, real) !== '' || !(await fs.stat(real)).isDirectory()) {
      throw new Error('승인된 실행 프로젝트가 변경됐습니다.');
    }
    return real;
  }
  async prepare(job) {
    await this.administrator(job.approvedBy);
    const cwd = await this.project(job);
    // Do not impose the Slack bridge's full tool mode on an owner's session.
    const { toolMode: _slackMode, ...options } = this.options;
    const view = await this.createSession({ ...options, cwd });
    try {
      const state = view.getState();
      if (!state.sessionId || state.sessionId === job.sessionId || path.relative(cwd, state.cwd) !== '') {
        throw new Error('별도 관리자 실행 세션을 확인하지 못했습니다.');
      }
      if (!await view.renameSessionTitle(state.sessionId, `관리자 작업 | ${job.goal.slice(0, 100)}`, { preservePrefix: true })) {
        throw new Error('관리자 작업 세션 제목을 저장하지 못했습니다.');
      }
      this.views.set(job.id, { view, files: new HubFiles(cwd) });
      return { sessionId: state.sessionId };
    } catch (error) { await view.dispose(); throw error; }
  }
  async attachment(job) {
    const cwd = await this.project(job);
    let attachment = this.views.get(job.id);
    if (!attachment) {
      const { toolMode: _slackMode, ...options } = this.options;
      const view = await this.createSession({ ...options, cwd, sessionId: job.executionSessionId });
      attachment = { view, files: new HubFiles(cwd) };
      this.views.set(job.id, attachment);
    }
    const state = attachment.view.getState();
    if (state.sessionId !== job.executionSessionId || path.relative(cwd, state.cwd) !== '') {
      throw new Error('승인된 실행 세션과 현재 세션이 다릅니다.');
    }
    return attachment;
  }
  async submit(job) {
    await this.administrator(job.approvedBy);
    const { view } = await this.attachment(job);
    return { accepted: await view.submitAsync(jobHandoff(job), { id: job.id }) === true };
  }
  async inspect(job) {
    const { view, files } = await this.attachment(job);
    await view.resume(job.executionSessionId);
    const state = view.getState();
    if (state.sessionId !== job.executionSessionId || path.relative(job.projectPath, state.cwd) !== '') {
      throw new Error('실행 중 세션의 작업 대상이 변경됐습니다.');
    }
    if (state.toolApproval) {
      const pending = state.toolApproval;
      return { status: 'waiting', pendingApproval: {
        id: pending.id, name: pending.name, args: redactToolCallArgumentsValue(pending.args),
        reason: redactToolCallArgumentsValue(pending.reason), expiresAt: pending.expiresAt,
      } };
    }
    const items = state.items || [];
    const user = items.find((item) => item.kind === 'user'
      && (item.messageId === job.id || item.text?.startsWith(`[SOFTON approved job ${job.id}]`)));
    const done = user && items.find((item) => item.kind === 'turndone' && item.checkpointId === user.id);
    if (!done) return { status: state.userQuestion ? 'waiting' : 'running' };
    const segment = items.slice(items.indexOf(user) + 1, items.indexOf(done));
    const answers = segment.filter((item) => item.kind === 'assistant' && item.channel !== 'analysis' && item.streaming !== true)
      .map((item) => item.text || '').filter((value) => value.trim());
    if (done.status !== 'done' || !answers.length) return { status: done.status === 'cancelled' ? 'cancelled' : 'failed' };
    const projected = projectHubState({ ...state, items: segment });
    return { status: 'review', result: {
      summary: redactToolCallArgumentsValue(answers.join('\n\n')).slice(0, 100_000),
      files: await files.snapshot(job.id, projected.producedPaths),
    } };
  }
  async approve(job, person, input) {
    await this.administrator(person);
    const { view } = await this.attachment(job);
    await view.resume(job.executionSessionId);
    if (view.getState().toolApproval?.id !== input.approvalId) throw new Error('현재 도구 승인 요청이 아닙니다.');
    return { accepted: await view.approveAsync(input.approvalId, {
      approved: input.approved, reason: `SOFTON 작업 ${job.id} 관리자 ${person.teamId}:${person.userId}`,
      device: 'SOFTON 공유실',
    }) === true };
  }
  async abort(job) {
    const { view } = await this.attachment(job);
    const result = await view.abortAsync();
    return { aborted: result?.aborted === true };
  }
  async file(job, fileId, sha256) {
    const { files } = await this.attachment(job);
    const published = job.files.find((file) => file.id === fileId && file.sha256 === sha256);
    if (!published) throw new Error('공개된 산출물이 아닙니다.');
    const current = (await files.snapshot(job.id, [published.path]))[0];
    if (!current || current.id !== fileId || current.sha256 !== sha256) throw new Error('공개 이후 산출물이 변경됐습니다.');
    return files.file(job.id, fileId, sha256);
  }
  async record(job) {
    const { view } = await this.attachment(job);
    return view.recordApprovedJob({
      jobId: job.id, requester: `${job.teamId}:${job.userId}`, goal: job.goal, checks: job.checks,
      status: job.status, summary: job.summary, approvedBy: `${job.approvedBy.teamId}:${job.approvedBy.userId}`,
    });
  }
  async close() {
    await Promise.all([...this.views.values()].map(({ view }) => view.dispose()));
    this.views.clear();
  }
}
