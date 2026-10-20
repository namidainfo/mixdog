import { recordLabel, recordSide, recentRecords } from '../records.mjs';

export function mountHub(document, request) {
  const $ = (selector) => document.querySelector(selector);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const statuses = { running: '진행 중', waiting: '답변 대기', done: '완료', idle: '대기', error: '오류', unknown: '조회 불가' };
  const stamp = (at) => at ? new Date(at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) + ' KST' : '시각 기록 없음';
  let me = null, rows = [], selected = null, tab = 'conversation', selectedRecord = null, challengeId = null, pendingWiki = null;
  const snapshots = new Map(), errors = new Map(), documents = new Map();
  const announce = (text) => { $('#announcement').textContent = text; };
  function clearPrivate() {
    me = null; rows = []; selected = null; pendingWiki = null;
    snapshots.clear(); documents.clear(); errors.clear();
    $('#workspace').hidden = true; $('#login').hidden = false; $('#logout').hidden = true;
    $('#viewer-name').textContent = '본인 인증 필요';
    $('#detail').replaceChildren(); $('#session-list').replaceChildren(); $('#flow-marks').replaceChildren();
    $('#wiki-dialog').close(); $('#file-dialog').close();
    $('#wiki-preview').textContent = ''; $('#file-content').textContent = ''; $('#login-code').value = '';
  }
  async function api(path, input, raw = false) {
    const response = await request(path, {
      credentials: 'same-origin', cache: 'no-store',
      ...(input === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json',
        ...(me ? { 'x-csrf-token': me.csrf } : {}) }, body: JSON.stringify(input) }),
    });
    if (!response.ok) {
      const value = await response.json();
      if (response.status === 401 && me) clearPrivate();
      if (response.status === 404) {
        const id = /^\/api\/sessions\/([^/]+)/u.exec(path)?.[1];
        if (id) { snapshots.delete(id); documents.delete(id); render(); }
      }
      throw new Error(value.error || '요청 결과를 확인하지 못했습니다.');
    }
    return raw ? response : response.json();
  }
  async function run(operation, control) {
    if (control) control.disabled = true;
    try { await operation(); } catch (error) { announce(error.message); }
    finally { if (control?.isConnected) control.disabled = false; }
  }
  function button(text, operation, className = '') {
    const node = el('button', className, text); node.type = 'button';
    node.addEventListener('click', () => void run(operation, node)); return node;
  }
  function pill(state) { return el('span', `pill ${state === 'waiting' ? 'wait' : state === 'error' || state === 'unknown' ? 'error' : ''}`, statuses[state] || state); }
  function visible() {
    const query = $('#search').value.trim().toLocaleLowerCase();
    return rows.filter((row) => (snapshots.get(row.id)?.title || row.title).toLocaleLowerCase().includes(query)
      && ($('#status-filter').value === 'all' || (snapshots.get(row.id)?.state || 'unknown') === $('#status-filter').value)
      && (!me.admin || $('#owner-filter').value === 'all' || row.userId === $('#owner-filter').value));
  }
  async function loadSnapshot(id) {
    try {
      const snapshot = await api(`/api/sessions/${id}`);
      if (!me) return;
      snapshots.set(id, snapshot); errors.delete(id);
    } catch (error) { if (me) errors.set(id, error.message); throw error; }
  }
  async function loadList() {
    const result = await api('/api/sessions');
    rows = result.sessions;
    const ids = new Set(rows.map((row) => row.id));
    for (const id of snapshots.keys()) if (!ids.has(id)) { snapshots.delete(id); documents.delete(id); }
    const resultStates = await Promise.allSettled(rows.map((row) => loadSnapshot(row.id)));
    if (!me) return;
    const owners = new Map(rows.map((row) => [row.userId, row.userName]));
    $('#owner-filter').replaceChildren(new document.defaultView.Option('모든 사용자', 'all'));
    for (const [id, name] of owners) $('#owner-filter').append(new document.defaultView.Option(name, id));
    render();
    const failures = resultStates.filter((result) => result.status === 'rejected');
    announce(failures.length ? `${failures.length}개 세션의 갱신에 실패했습니다. 해당 세션을 선택해 다시 갱신해 주세요.`
      : '조회 범위 내 스냅샷을 갱신했습니다. 실행 명령은 보내지 않았습니다.');
  }
  function renderFlow(filtered) {
    const scope = me.admin ? filtered.filter((row) => row.id === selected) : filtered;
    const records = scope.flatMap((row) => (snapshots.get(row.id)?.records || []).map((record) =>
      ({ ...record, sessionId: row.id, sessionTitle: snapshots.get(row.id)?.title || row.title })))
      .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
    const recent = recentRecords(records);
    $('#flow-marks').replaceChildren();
    for (const record of recent) {
      const mark = button('', () => {
        selected = record.sessionId; tab = 'records'; selectedRecord = record.id; render();
        $('#detail').scrollIntoView({ block: 'nearest' });
      }, 'flow-mark');
      mark.dataset.kind = record.kind; mark.dataset.here = String(record.sessionId === selected);
      mark.setAttribute('aria-label', `${recordLabel(record.kind)} · ${record.title} · ${record.sessionTitle}`);
      mark.title = `${recordLabel(record.kind)} · ${record.title}\n${stamp(record.at)}`;
      mark.setAttribute('aria-pressed', String(selectedRecord === record.id && selected === record.sessionId));
      mark.append(el('span', `flow-stem ${recordSide(record.kind)}`)); $('#flow-marks').append(mark);
    }
    $('#flow-help').textContent = recent.length ? '간격은 경과 시간이 아닙니다. 막대를 선택하면 해당 작업과 기록을 표시합니다.'
      : '조회 범위의 세션에 저장 성공이 확인된 Worktrail 기록이 아직 없습니다.';
  }
  function render() {
    if (!me) return;
    $('#login').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false;
    $('#viewer-name').textContent = `${me.userName || me.userId} · ${me.admin ? '관리자' : '일반 사용자'}`;
    $('#list-heading').textContent = me.admin ? '전체 세션' : '내 세션';
    $('#scope-label').textContent = me.admin ? '조회 범위 · 관리자 전체 조회' : `조회 범위 · ${me.userName || me.userId} 본인`;
    $('#owner-label').hidden = !me.admin;
    const filtered = visible();
    if (!filtered.some((row) => row.id === selected)) selected = filtered[0]?.id || null;
    $('#session-count').textContent = `${filtered.length}개`; $('#session-list').replaceChildren();
    for (const row of filtered) {
      const snapshot = snapshots.get(row.id);
      const node = button('', () => { selected = row.id; tab = 'conversation'; selectedRecord = null; render(); }, 'session');
      node.setAttribute('aria-pressed', String(selected === row.id));
      node.append(el('span', 'muted small', row.userName), el('strong', '', snapshot?.title || row.title));
      const meta = el('span', 'session-meta');
      meta.append(pill(snapshot?.state || 'unknown'), el('span', '', snapshot ? stamp(snapshot.updatedAt) : '갱신 필요'));
      node.append(meta); $('#session-list').append(node);
    }
    renderFlow(filtered); $('#detail').replaceChildren();
    if (!selected) {
      const empty = el('div', 'empty');
      empty.append(el('h2', '', '조회할 세션이 없습니다.'), el('p', 'muted', '검색 조건을 바꾸거나 Slack에서 새 작업을 시작해 주세요.'));
      $('#detail').append(empty); return;
    }
    renderDetail(snapshots.get(selected));
  }
  async function refreshSelected() {
    const id = selected;
    try {
      const value = await api(`/api/sessions/${id}/snapshot`, {});
      if (!me) return;
      snapshots.set(id, value); errors.delete(id); render(); announce('선택한 세션의 스냅샷을 갱신했습니다.');
    } catch (error) { if (me) { errors.set(id, error.message); render(); } throw error; }
  }
  function renderDetail(snapshot) {
    const head = el('header', 'detail-head');
    const refresh = button('스냅샷 갱신', refreshSelected); refresh.id = 'refresh';
    if (!snapshot) {
      head.append(el('h2', '', '세션 스냅샷을 불러오지 못했습니다.'), el('p', 'muted', errors.get(selected) || '다시 갱신해 주세요.'), refresh);
      $('#detail').append(head); return;
    }
    head.append(pill(snapshot.state), el('h2', 'session-heading', snapshot.title));
    const meta = el('div', 'detail-meta');
    meta.append(el('span', '', `소유자 ${snapshot.userName}`), el('span', '', `Slack ${snapshot.channelId} / ${snapshot.threadTs}`));
    head.append(meta);
    const row = el('div', 'snapshot'), copy = el('div', 'snapshot-copy');
    copy.append(el('strong', '', `마지막 갱신 ${stamp(snapshot.updatedAt)}`),
      el('span', 'muted small', '현재 실행 화면이 아닌 갱신 시점까지의 기록입니다.'));
    row.append(copy, refresh); head.append(row);
    if (errors.has(snapshot.id)) head.append(el('p', 'notice error', `갱신 실패 · ${errors.get(snapshot.id)} 마지막 정상 스냅샷을 유지합니다.`));
    $('#detail').append(head);
    const nav = el('nav', 'tabs'); nav.setAttribute('aria-label', '세션 상세 보기');
    for (const [key, label] of [['conversation', '대화 내역'], ['files', `산출물 ${snapshot.files.length}`], ['records', '작업 기록'], ['wiki', 'CloudWiki 문서화']]) {
      const control = button(label, async () => {
        tab = key;
        if (key === 'wiki') documents.set(snapshot.id, (await api(`/api/sessions/${snapshot.id}/documents`)).documents);
        render();
      });
      control.dataset.tab = key; control.setAttribute('aria-pressed', String(tab === key)); nav.append(control);
    }
    $('#detail').append(nav);
    const panel = el('section', 'panel'); panel.id = 'active-panel'; $('#detail').append(panel);
    if (tab === 'conversation') {
      panel.append(el('p', 'panel-lead', '완료된 메시지와 공개 답변만 표시합니다. 내부 추론·인증 정보·도구 원문은 제외합니다.'));
      for (const message of snapshot.messages) {
        const article = el('article', 'message'), heading = el('div', 'message-head');
        const speaker = ['user', 'assistant', 'error'].includes(message.by) ? message.by : 'error';
        article.dataset.speaker = speaker;
        heading.append(el('strong', '', speaker === 'user' ? snapshot.userName || snapshot.userId : speaker === 'error' ? '시스템' : 'SOFTON'),
          el('span', '', speaker === 'user' ? '사용자' : speaker === 'error' ? '오류' : 'AI'), el('time', '', stamp(message.at)));
        article.append(heading, el('p', 'message-body', message.text)); panel.append(article);
      }
      if (snapshot.waitingFor) panel.append(el('p', 'notice', `${snapshot.waitingFor} 대기 중입니다. 질문에는 원래 Slack 스레드에서 답변해 주세요. 일반 사용자의 도구 실행은 PC 소유자가 SOFTON 승인 화면에서 확인해야 합니다.`));
    }
    if (tab === 'files') renderFiles(panel, snapshot);
    if (tab === 'records') {
      panel.append(el('p', 'panel-lead', '이 세션에서 저장 성공이 확인된 Worktrail 기록만 표시합니다. 다른 세션의 원본 기록은 조회하지 않습니다.'));
      for (const record of snapshot.records) {
        const article = el('article', 'record'); article.dataset.selected = String(record.id === selectedRecord);
        const heading = el('div', 'record-heading'); heading.dataset.kind = record.kind;
        heading.append(el('span', '', recordLabel(record.kind)), el('time', '', stamp(record.at)));
        article.append(heading, el('strong', '', record.title), el('p', '', record.body));
        if (record.conclusion) article.append(el('p', '', `판단\n${record.conclusion}`));
        if (record.next) article.append(el('p', '', `다음 작업 · ${record.next}\n담당 ${record.owner || '기록 없음'}`));
        panel.append(article);
      }
      if (!snapshot.records.length) panel.append(el('p', 'muted', '아직 이 세션의 Worktrail 기록이 없습니다.'));
    }
    if (tab === 'wiki') renderWiki(panel, snapshot);
  }
  function fileUrl(snapshot, file) {
    return `/api/sessions/${snapshot.id}/files/${file.id}?version=${file.sha256}`;
  }
  function renderFiles(panel, snapshot) {
    panel.append(el('p', 'panel-lead', '성공한 파일 생성·수정 도구 호출로 확인한 산출물만 표시합니다. 보호 파일과 프로젝트 외부 경로는 제외합니다. 다운로드 최대 20MiB.'));
    for (const file of snapshot.files) {
      const row = el('article', 'file-row'), info = el('div'), actions = el('div', 'actions');
      info.append(el('code', '', file.path), el('p', 'muted', `${file.size.toLocaleString()} bytes · ${stamp(file.modifiedAt)}`));
      if (file.downloadable === false) {
        actions.append(el('span', 'muted small', '20MiB 초과 · 목록만 표시'));
        row.append(info, actions); panel.append(row); continue;
      }
      if (/\.(?:txt|md|json|csv|tsv|html|svg|css|js|mjs|ts|py|log|yaml|yml)$/iu.test(file.path) && file.size <= 200_000) {
        actions.append(button('미리보기', async () => {
          const response = await api(fileUrl(snapshot, file), undefined, true);
          $('#file-heading').textContent = file.path; $('#file-content').textContent = await response.text(); $('#file-dialog').showModal();
        }));
      }
      const link = el('a', 'file-link', '다운로드'); link.href = fileUrl(snapshot, file); link.download = '';
      actions.append(link); row.append(info, actions); panel.append(row);
    }
    if (!snapshot.files.length) panel.append(el('p', 'muted', '확인된 산출물이 없습니다. 셸 출력에서 경로를 추측하거나 전체 폴더를 공개하지 않습니다.'));
  }
  function renderWiki(panel, snapshot) {
    panel.append(el('p', 'panel-lead', '작업 기록을 정리한 초안을 검토한 뒤 승인 대기에 제출합니다. 모델 호출이나 자동 공개 게시를 하지 않습니다.'));
    const meta = el('div', 'wiki-meta');
    meta.append(el('span', '', 'https://namidainfo-cloudwiki.namidainfo.workers.dev/w/CloudWiki'), el('span', '', '기존 서버 자격 증명·승인 정책 사용 · 브라우저에 토큰 전달 안 함'));
    panel.append(meta, button('작업 기록으로 새 초안 만들기', async () => {
      await api(`/api/sessions/${snapshot.id}/documents`, {});
      documents.set(snapshot.id, (await api(`/api/sessions/${snapshot.id}/documents`)).documents); render();
    }));
    for (const doc of documents.get(snapshot.id) || []) {
      const editor = el('section', 'editor');
      const label = el('label', '', '문서 제목'), title = el('input'); title.value = doc.title; title.maxLength = 180;
      const bodyLabel = el('label', '', '검토 가능한 요약 초안'), body = el('textarea'); body.value = doc.content;
      const readonly = doc.status !== 'draft'; title.readOnly = readonly; body.readOnly = readonly;
      title.addEventListener('input', () => { doc.title = title.value; }); body.addEventListener('input', () => { doc.content = body.value; });
      label.append(title); bodyLabel.append(body);
      editor.append(el('h3', '', `${doc.status === 'submitted' ? '승인 대기 제출 완료' : doc.status === 'draft' ? '초안' : '전송 결과 확인 필요'} · 버전 ${doc.revision}`), label, bodyLabel);
      if (doc.status !== 'submitted') {
        editor.append(button(readonly ? '같은 문서 검토·상태 확인' : '저장하고 승인 요청 검토', async () => {
          const saved = readonly ? doc : await api(`/api/sessions/${snapshot.id}/documents/${doc.id}/save`, { revision: doc.revision, title: doc.title, content: doc.content });
          documents.set(snapshot.id, (await api(`/api/sessions/${snapshot.id}/documents`)).documents);
          pendingWiki = { sessionId: snapshot.id, id: saved.id, revision: saved.revision };
          $('#wiki-preview').textContent = `${saved.title}\n\n${saved.content}`;
          $('#confirm-wiki').checked = false; $('#submit-wiki').disabled = true; $('#wiki-dialog').showModal();
        }, 'primary'));
      } else editor.append(el('p', 'notice success', `CloudWiki 초안 ${doc.remoteDraftId} · 최종 공개는 CloudWiki에서 승인합니다.`));
      panel.append(editor);
    }
  }
  $('#challenge-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const result = await api('/api/auth/challenge', { teamId: $('#team-id').value.trim(), userId: $('#user-id').value.trim() });
      challengeId = result.challengeId; $('#verify-form').hidden = false; announce(result.message); $('#login-code').focus();
    }, event.submitter);
  });
  $('#verify-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      await api('/api/auth/verify', { challengeId, code: $('#login-code').value });
      $('#login-code').value = ''; challengeId = null; me = await api('/api/me'); await loadList();
    }, event.submitter);
  });
  $('#logout').addEventListener('click', () => void run(async () => { await api('/api/logout', {}); clearPrivate(); announce('로그아웃했습니다.'); }));
  $('#reload-list').addEventListener('click', (event) => void run(loadList, event.currentTarget));
  for (const id of ['search', 'status-filter', 'owner-filter']) $(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change', render);
  document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', () => document.getElementById(node.dataset.close).close()));
  $('#confirm-wiki').addEventListener('change', () => { $('#submit-wiki').disabled = !$('#confirm-wiki').checked; });
  $('#submit-wiki').addEventListener('click', (event) => void run(async () => {
    if (!pendingWiki || !$('#confirm-wiki').checked || !me) return;
    const pending = pendingWiki; pendingWiki = null; $('#wiki-dialog').close(); $('#wiki-preview').textContent = '';
    try { await api(`/api/sessions/${pending.sessionId}/documents/${pending.id}/submit`, { revision: pending.revision, confirm: true }); }
    finally {
      if (me) {
        documents.set(pending.sessionId, (await api(`/api/sessions/${pending.sessionId}/documents`)).documents);
        render();
      }
    }
    announce('CloudWiki 승인 대기 제출을 확인했습니다. 공개 게시는 별도 승인 대상입니다.');
  }, event.currentTarget));
  const ready = run(async () => {
    try { me = await api('/api/me'); } catch (error) { clearPrivate(); announce(error.message); return; }
    await loadList();
  });
  return { ready };
}
