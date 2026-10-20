import { jobRequestText } from '../job-contract.mjs';

const labels = {
  pending: '관리자 승인 대기', starting: '실행 준비 중', running: '실행 중', waiting: '관리자 응답 대기',
  review: '결과 검토 대기', completed: '검증 완료', rejected: '거절됨', cancelled: '취소 확인',
  cancelling: '중지 확인 중', failed: '실행 실패', uncertain: '실행 상태 확인 필요',
};
const delivery = { not_started: '미시작', sending: '전달 중', sent: '전달 확인', queued: '전달 대기',
  unavailable: '알림 연결 없음', uncertain: '전달 확인 실패' };
const recording = { local_only: '로컬 작업 이력 저장', writing: 'Worktrail 저장 중',
  saved: 'Worktrail 저장 확인', failed: 'Worktrail 저장 확인 실패', uncertain: 'Worktrail 저장 확인 필요' };

export function mountJobs(document, { api, currentUser, sourceSession, sourceSnapshot, announce }) {
  const $ = (selector) => document.querySelector(selector), dialog = $('#jobs-dialog');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let rows = [], selected = null;
  async function run(operation, control) {
    if (control) control.disabled = true;
    try { await operation(); } catch (error) { announce(error.message); }
    finally { if (control?.isConnected) control.disabled = false; }
  }
  const button = (title, operation, className = '') => {
    const node = el('button', className, title); node.type = 'button';
    node.addEventListener('click', () => void run(operation, node)); return node;
  };
  const field = (container, id, title, value = '', multiline = false) => {
    const label = el('label', '', title), input = el(multiline ? 'textarea' : 'input');
    input.id = id; input.value = value; label.append(input); container.append(label); return input;
  };
  const check = (container, id, title) => {
    const label = el('label', 'check'), input = el('input'); input.type = 'checkbox'; input.id = id;
    label.append(input, document.createTextNode(title)); container.append(label); return input;
  };
  async function load() {
    const value = await api('/api/jobs');
    if (!currentUser()) return clear();
    rows = value.jobs;
    if (!rows.some((row) => row.id === selected)) selected = rows[0]?.id || null;
    render();
  }
  async function action(job, operation, input) {
    await api(`/api/jobs/${job.id}/${operation}`, { revision: job.revision, ...input });
    await load();
  }
  function editor(job = null) {
    const panel = $('#job-detail'); panel.replaceChildren();
    const source = job?.sessionId || sourceSession();
    if (!source) { panel.append(el('p', 'notice', 'Slack에서 작업을 시작하고 사이드바의 본인 세션을 선택해 주세요.')); return; }
    const form = el('form', 'editor'); form.id = 'job-request-form';
    form.append(el('h3', '', job ? '승인 대기 요청 수정' : '선택 세션의 관리자 작업 요청'));
    const original = sourceSnapshot()?.messages.findLast((message) => message.by === 'user')?.text || '';
    const goal = field(form, 'job-goal', '작업 목표', job?.goal || original, true);
    const checks = field(form, 'job-checks', '완료 검증 방법', job?.checks || '', true);
    const constraints = field(form, 'job-constraints', '추가 제한',
      job?.constraints || '기존 변경 보존. 커밋·배포·설치·권한 변경은 별도 승인.', true);
    goal.required = true; goal.maxLength = 20_000; checks.required = true; checks.maxLength = 10_000;
    constraints.required = true; constraints.maxLength = 10_000;
    const preview = el('pre', 'preview'); preview.id = 'job-prompt-preview';
    const data = () => ({ goal: goal.value, checks: checks.value, constraints: constraints.value });
    const update = () => { preview.textContent = jobRequestText(data()); };
    for (const input of [goal, checks, constraints]) input.addEventListener('input', update);
    update();
    form.append(el('h3', '', '관리자에게 전달할 인계 프롬프트'), preview);
    const submit = el('button', 'primary', '인계 요청 저장'); submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void run(async () => {
        const saved = job ? await api(`/api/jobs/${job.id}/revise`, { revision: job.revision, ...data() })
          : await api(`/api/sessions/${source}/jobs`, data());
        selected = saved.id; await load(); announce('관리자 검토용 요청을 저장했습니다. 아직 실행하지 않았습니다.');
      }, submit);
    });
    panel.append(form);
  }
  function renderDetail(job) {
    const panel = $('#job-detail');
    panel.append(el('h3', '', labels[job.status]), el('p', 'muted small', `요청자 ${job.userName || job.userId} · 버전 ${job.revision}`),
      el('pre', 'preview', jobRequestText(job)));
    panel.append(el('p', 'muted small', `Slack 알림: ${delivery[job.notification?.status] || '미확인'} · 기록: ${recording[job.recording?.status] || '미확인'}`));
    if (job.summary) panel.append(el('pre', 'preview', job.summary));
    for (const file of job.files || []) {
      const link = el('a', 'file-link', file.path);
      link.href = `/api/jobs/${job.id}/files/${file.id}?version=${file.sha256}`; link.download = ''; panel.append(link);
    }
    const actor = currentUser();
    if (actor.userId === job.userId && job.status === 'pending') panel.append(button('인계 요청 수정', () => editor(job)));
    if (actor.admin) {
      if (job.executionSessionId) panel.append(el('p', 'muted small',
        `관리자 PC 실행 세션: ${job.executionSessionId}. 사용자 질문은 해당 실행 세션에서 답변해 주세요.`));
      if (job.status === 'pending') {
        const section = el('section', 'editor');
        const project = field(section, 'job-project-path', '관리자 실행 PC의 실제 프로젝트 절대 경로');
        const confirmed = check(section, 'job-approve-confirm', '인계 내용·실행 프로젝트·기존 소유자 승인 정책을 확인했습니다. 임의 비신뢰 코드의 격리 실행이 아님을 이해합니다.');
        section.append(button('이 버전 승인하고 인수', async () => {
          if (!confirmed.checked) throw new Error('작업 범위와 실행 환경을 먼저 확인해 주세요.');
          await action(job, 'approve', { confirm: true, projectPath: project.value });
        }, 'primary'));
        const reason = field(section, 'job-reject-reason', '요청자에게 전달할 거절 사유', '', true);
        section.append(button('요청 거절', () => action(job, 'reject', { summary: reason.value })));
        panel.append(section);
      }
      if (job.pendingApproval) {
        panel.append(el('h3', '', '정확한 도구 호출 검토'), el('pre', 'preview', JSON.stringify(job.pendingApproval, null, 2)));
        panel.append(button('이 도구 호출 승인', () => action(job, 'tool-decision', { approvalId: job.pendingApproval.id, approved: true })),
          button('이 도구 호출 거절', () => action(job, 'tool-decision', { approvalId: job.pendingApproval.id, approved: false })));
      }
      if (job.status === 'review') {
        const section = el('section', 'editor');
        const result = el('pre', 'preview', job.result.summary); result.id = 'job-private-result';
        section.append(el('h3', '', '관리자 전용 실행 결과 — 자동 공개하지 않습니다.'), result);
        const summary = field(section, 'job-public-summary', '검증 후 요청자에게 공개할 결과', '', true);
        const files = [];
        for (const file of job.result.files) {
          if (file.downloadable === false) continue;
          const chosen = check(section, `publish-${file.id}`, `공개할 산출물: ${file.path}`);
          files.push({ chosen, id: file.id });
        }
        const verified = check(section, 'job-complete-confirm', '검증 방법의 실제 결과와 공개 내용의 비밀정보·접근 범위를 확인했습니다.');
        section.append(button('검증 완료 및 선택 결과 공개', async () => {
          if (!verified.checked) throw new Error('실제 검증과 공개 범위를 확인해 주세요.');
          await action(job, 'complete', { confirm: true, summary: summary.value, fileIds: files.filter((file) => file.chosen.checked).map((file) => file.id) });
        }, 'primary'));
        panel.append(section);
      }
    }
    if (['pending', 'starting', 'running', 'waiting', 'review', 'uncertain'].includes(job.status)) {
      panel.append(button('작업 취소·중지 요청', () => action(job, 'cancel', {})));
    }
  }
  function render() {
    $('#job-list').replaceChildren(); $('#job-detail').replaceChildren();
    for (const row of rows) {
      const control = button(`${labels[row.status]} · ${row.userName || row.userId} · ${row.goal.slice(0, 100)}`, () => { selected = row.id; render(); }, 'session');
      control.dataset.jobId = row.id; control.setAttribute('aria-pressed', String(row.id === selected)); $('#job-list').append(control);
    }
    const job = rows.find((row) => row.id === selected);
    if (job) renderDetail(job);
    else $('#job-detail').append(el('p', 'muted', '조회 가능한 관리자 작업 요청이 없습니다.'));
  }
  function clear() {
    rows = []; selected = null; dialog.close();
    $('#job-list').replaceChildren(); $('#job-detail').replaceChildren();
  }
  $('#open-jobs').addEventListener('click', (event) => void run(async () => {
    if (!currentUser()) return;
    await load();
    if (currentUser()) dialog.showModal();
  }, event.currentTarget));
  $('#reload-jobs').addEventListener('click', (event) => void run(load, event.currentTarget));
  $('#new-job').addEventListener('click', () => editor());
  return { clear };
}
