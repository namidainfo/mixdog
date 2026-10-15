import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorktrailAction, WorktrailDetail, WorktrailDocument, WorktrailResponses, WorktrailReview,
  WorktrailSearchResult, WorktrailSession,
} from '../../shared/worktrail-contract';
import { canSubmitDocument, completedCase, documentDirty, documentStatuses, worktrailRows } from './worktrail-model';
import { WorktrailRecordFlow, WorktrailRecentRecords } from './WorktrailRecordFlow';
import { worktrailRecords, worktrailStamp as stamp, type WorktrailRecord } from './worktrail-records';

const MarkdownPreview = lazy(() => import('../EditorTextViews').then(module => ({ default: module.EditorMarkdownPreview })));
const views = { status: '현황', search: '작업 검색', prior: '이전 세션', documents: '문서화' } as const;
type View = keyof typeof views;

async function request<K extends WorktrailAction>(action: K, input: Record<string, unknown> = {}): Promise<WorktrailResponses[K]> {
  const api = window.mixdogDesktop?.worktrailRequest;
  if (!api) throw new Error('Worktrail 연결을 사용할 수 없습니다. 개인용 실행본을 확인해 주세요.');
  return await api(action, input) as WorktrailResponses[K];
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function WorktrailPane({ active }: { active: boolean }) {
  const [view, setView] = useState<View>('status');
  const [review, setReview] = useState<WorktrailReview | null>(null);
  const [checkedAt, setCheckedAt] = useState<number>();
  const [reviewError, setReviewError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  const [selectionSequence, setSelectionSequence] = useState(0);
  const [detail, setDetail] = useState<WorktrailDetail | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [history, setHistory] = useState<WorktrailResponses['history'] | null>(null);
  const [historyLimit, setHistoryLimit] = useState(40);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<WorktrailSearchResult | null>(null);
  const [workspaces, setWorkspaces] = useState<NonNullable<WorktrailResponses['archive']['workspaces']>>([]);
  const [sessions, setSessions] = useState<WorktrailSession[]>([]);
  const [prior, setPrior] = useState<WorktrailResponses['prior'] | null>(null);
  const [caseIds, setCaseIds] = useState<number[]>([]);
  const [documents, setDocuments] = useState<WorktrailResponses['documents']>([]);
  const [document, setDocument] = useState<WorktrailDocument | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [wikiConnection, setWikiConnection] = useState('CloudWiki 연결 상태 미확인');
  const [deleting, setDeleting] = useState(false);
  const docSequence = useRef(0);
  const searchSequence = useRef(0);
  const selectedCase = useRef(selected);
  selectedCase.current = selected;
  const dirty = documentDirty(document, title, content);
  const locked = Boolean(document && document.status !== 'draft');
  const rows = worktrailRows(review);
  const records = useMemo(() => worktrailRecords(review), [review]);
  const recentRecords = useMemo(() => records.filter(record => record.caseId === selected).slice(-6), [records, selected]);
  const flowRecords = useMemo(() => view === 'search'
    ? records.filter(record => hits?.results.some(hit => hit.caseId === record.caseId)) : records, [records, hits, view]);
  const completedRows = rows.filter(row => completedCase(row.state));
  const selectRecord = (record: WorktrailRecord) => {
    setSelected(record.caseId); setSelectedRecord(record.key); setSelectionSequence(value => value + 1); setHistory(null);
  };
  const openDocument = (value: WorktrailDocument) => {
    setDocument(value); setTitle(value.title); setContent(value.content); setConfirmed(false); setDeleting(false);
  };
  const run = async (label: string, operation: () => Promise<void>, onError: (value: string) => void = setError) => {
    setBusy(label); setError(''); setNotice('');
    try { await operation(); } catch (problem) { onError(message(problem)); } finally { setBusy(''); }
  };
  const refresh = useCallback(async () => {
    const value = await request('review');
    setReview(value); setCheckedAt(Date.now()); setReviewError('');
  }, []);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () => request('review').then(value => {
      if (live) { setReview(value); setCheckedAt(Date.now()); setReviewError(''); }
    }).catch(problem => { if (live) setReviewError(message(problem)); });
    void read();
    const timer = view === 'status' ? window.setInterval(() => void read(), 15_000) : undefined;
    return () => { live = false; window.clearInterval(timer); };
  }, [active, view]);
  useEffect(() => {
    if (!active || !selected || (view !== 'status' && view !== 'search')) return;
    let live = true;
    setDetail(null); setDetailPending(true); setError(''); setHistory(null); setHistoryLimit(40);
    void request('thread', { id: selected }).then(value => { if (live) setDetail(value); })
      .catch(problem => { if (live) setError(message(problem)); })
      .finally(() => { if (live) setDetailPending(false); });
    return () => { live = false; };
  }, [active, selected, view]);
  useEffect(() => {
    if (!active || view !== 'documents') return;
    let live = true;
    void request('documents').then(value => { if (live) setDocuments(value); })
      .catch(problem => { if (live) setError(message(problem)); });
    return () => { live = false; };
  }, [active, view]);
  useEffect(() => {
    if (!active || view !== 'prior') return;
    let live = true;
    void request('archive').then(value => { if (live) setWorkspaces(value.workspaces ?? []); })
      .catch(problem => { if (live) setError(message(problem)); });
    return () => { live = false; };
  }, [active, view]);

  const search = (offset = 0) => run('검색', async () => {
    const sequence = ++searchSequence.current;
    const result = await request('search', { query, offset });
    if (sequence !== searchSequence.current) return;
    setHits(current => offset && current?.query === result.query ? { ...result, results: [...current.results, ...result.results] } : result);
  });
  const chooseDocument = (id: string) => run('문서 열기', async () => {
    if (dirty) throw new Error('수정한 문서를 먼저 저장해 주세요.');
    const sequence = ++docSequence.current;
    const value = await request('document', { id });
    if (sequence === docSequence.current) openDocument(value);
  });
  const mutateDocument = (action: 'create' | 'save' | 'submit') => run(action === 'submit' ? '승인 요청' : '문서 저장', async () => {
    let value: WorktrailDocument;
    if (action === 'create') {
      if (dirty) throw new Error('수정한 문서를 먼저 저장해 주세요.');
      value = await request('create', { caseIds });
    } else {
      if (!document) return;
      try {
        value = await request(action, { id: document.id, revision: document.revision, title, content, confirm: confirmed });
      } catch (problem) {
        if (action === 'submit') openDocument(await request('document', { id: document.id }));
        throw problem;
      }
    }
    openDocument(value);
    setDocuments(await request('documents'));
    setNotice(action === 'submit' ? 'CloudWiki 승인 대기로 전송했습니다. 최종 게시는 CloudWiki에서 승인해 주세요.' : '문서를 저장했습니다.');
  });

  return <section className="worktrail-pane" aria-label="Worktrail">
    <nav className="worktrail-tabs" aria-label="Worktrail 화면">
      {Object.entries(views).map(([id, label]) => <button type="button" key={id} aria-pressed={view === id}
        onClick={() => { setView(id as View); setSelected(null); setSelectedRecord(null); setHistory(null); setError(''); setNotice(''); }}>{label}</button>)}
    </nav>
    {error && <p className="worktrail-error" role="alert">{error}</p>}
    {reviewError && <p className="worktrail-error" role="alert">{reviewError}</p>}
    {notice && <p className="worktrail-notice" role="status">{notice}</p>}
    {busy && <p className="worktrail-meta" role="status">{busy} 중…</p>}
    {view === 'documents' && <div className="worktrail-draft-actions">
      <span className="worktrail-selection-count" role="status" aria-live="polite">{caseIds.length}/20개 선택</span>
      <button type="button" disabled={!caseIds.length || Boolean(busy) || dirty}
        onClick={() => void mutateDocument('create')}>초안 만들기</button>
    </div>}
    <div className="worktrail-scroll">
      {(view === 'status' || view === 'search') && reviewError && review && <p className="worktrail-meta" role="status">
        마지막 조회 내용 · {stamp(checkedAt)}<br />현재 상태는 확인하지 못했습니다. 서비스 연결을 확인하고 다시 조회해 주세요.
      </p>}
      {view === 'status' && !selected && <>
        <div className="worktrail-actions"><label>작업 상태 <select value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">전체</option><option value="open">진행 중</option><option value="closed">완료</option>
        </select></label><button type="button" disabled={Boolean(busy)} onClick={() => void run('새로고침', refresh, setReviewError)}>새로고침</button></div>
        {!review && !error && !reviewError && <p className="worktrail-meta" role="status">Worktrail 작업을 조회하고 있습니다…</p>}
        {review && !rows.length && <p className="worktrail-meta">표시할 작업이 없습니다. Worktrail 서비스와 기록을 확인해 주세요.</p>}
        <WorktrailRecordFlow records={flowRecords} selected={null} selectedRecord={null} onSelect={selectRecord} />
        <div className="worktrail-list">{rows.filter(row => filter === 'all' || (filter === 'closed') === completedCase(row.state))
          .map(row => <button type="button" className="worktrail-record" key={row.id} aria-pressed={selected === row.id}
            onClick={() => { setSelected(row.id); setSelectedRecord(null); }}><strong>{row.title}</strong>
            <span>#{row.id} · {row.topic} · {completedCase(row.state) ? '완료' : '진행 중'}{row.owner ? ` · ${row.owner}` : ''}</span>
            {row.next && <span>{row.next}</span>}<span>{stamp(row.updated_at)}</span></button>)}</div>
      </>}
      {view === 'search' && !selected && <>
        <form className="worktrail-actions" onSubmit={event => { event.preventDefault(); void search(); }}>
          <label className="worktrail-grow">검색어 <input value={query} maxLength={200} placeholder="제목·주제·기록 본문·완료 결과"
            onChange={event => { searchSequence.current++; setQuery(event.target.value); setHits(null); }} /></label>
          <button type="submit" disabled={!query.trim() || Boolean(busy)}>검색</button>
        </form>
        <p className="worktrail-meta">작업 기록 검색입니다. 이전 세션 보관함의 원문은 포함하지 않습니다.</p>
        {hits && <p className="worktrail-meta">검색 결과 {hits.total}개</p>}
        <WorktrailRecordFlow records={flowRecords} selected={null} selectedRecord={null} onSelect={selectRecord} />
        {hits?.results.map(hit => <button type="button" className="worktrail-record" key={hit.caseId}
          onClick={() => { setSelected(hit.caseId); setSelectedRecord(null); }}><strong>{hit.title}</strong><span>#{hit.caseId} · {hit.topic}</span>
          {hit.matches.map((match, index) => <span key={index}>{match.snippet}</span>)}</button>)}
        {hits?.nextOffset != null && <button type="button" disabled={Boolean(busy)}
          onClick={() => void search(hits.nextOffset!)}>다음 검색 결과</button>}
      </>}
      {(view === 'status' || view === 'search') && selected && <div className="worktrail-selected">
        <div className="worktrail-actions"><button type="button" onClick={() => {
          setSelected(null); setSelectedRecord(null); setDetail(null); setHistory(null);
        }}>목록으로</button></div>
        {!detail && detailPending && <p className="worktrail-meta" role="status">선택한 작업을 조회하고 있습니다…</p>}
        {detail && <article className="worktrail-detail">
          <p className="worktrail-meta">#{selected} · {completedCase(detail.status) ? '완료' : '진행 중'}{detail.owner ? ` · ${detail.owner}` : ''}</p>
          <h3>{detail.title}</h3>
          {detail.focus?.statement && <><p className="worktrail-meta">현재 목표</p><p>{detail.focus.statement}</p></>}
          {detail.next?.statement && <><p className="worktrail-meta">다음 행동</p><p>{detail.next.statement}</p></>}
          {detail.result && <p className="worktrail-pre">{detail.result}</p>}
        </article>}
        <WorktrailRecordFlow records={flowRecords} selected={selected} selectedRecord={selectedRecord} onSelect={selectRecord} />
        <WorktrailRecentRecords records={recentRecords} selectedRecord={selectedRecord} selectionSequence={selectionSequence} />
        <div className="worktrail-actions">
          <button type="button" disabled={Boolean(busy)} onClick={() => void run('전체 기록 조회', async () => {
            const id = selected;
            const value = await request('history', { id });
            if (selectedCase.current === id) setHistory(value);
          })}>전체 기록</button>
          {detail && completedCase(detail.status) && <button type="button" onClick={() => { setCaseIds([selected]); setView('documents'); }}>
            이 작업으로 문서 만들기</button>}
        </div>
        {history?.conversation.slice(0, historyLimit).map(item => <div className="worktrail-event" key={item.id}>
          <p className="worktrail-meta">{item.role} · {stamp(item.created_at)}</p><p className="worktrail-pre">{item.content}</p>
        </div>)}
        {history && history.conversation.length > historyLimit && <button type="button" onClick={() => setHistoryLimit(value => value + 40)}>
          다음 기록 40개</button>}
      </div>}
      {view === 'prior' && <>
        <p className="worktrail-meta">저장소별 최근 세션 200개와 저장된 지시문을 열람합니다.</p>
        <div className="worktrail-list">{workspaces.map(workspace => <button type="button" className="worktrail-record"
          disabled={Boolean(busy)} key={workspace.repo_id} onClick={() => void run('세션 목록 조회', async () => {
            const value = await request('archive', { id: workspace.repo_id }); setSessions(value.sessions ?? []); setPrior(null);
          })}><strong>{workspace.repo}</strong><span>{workspace.sessions}개 세션</span></button>)}</div>
        {sessions.map(session => <button type="button" className="worktrail-record" disabled={Boolean(busy)} key={session.id}
          onClick={() => void run('이전 세션 조회', async () => { setPrior(await request('prior', { id: session.id })); })}>
          <strong>{session.title || session.first_instruction || `세션 ${session.id}`}</strong>
          <span>{session.source} · {stamp(session.started_at)}</span></button>)}
        {prior && <article className="worktrail-detail"><p className="worktrail-meta">{prior.source} · {prior.branch} · {prior.cwd}</p>
          {prior.items?.map(item => <p className="worktrail-pre" key={item.seq}>{item.text}</p>)}</article>}
      </>}
      {view === 'documents' && <>
        <p className="worktrail-meta">완료 기록을 선택해 초안을 만듭니다. 규칙 기반 초안이므로 본문·검증 범위·출처를 직접 검토해 주세요.</p>
        <details className="worktrail-picker" open={!document}>
          <summary>문서로 만들 완료 작업 · {completedRows.length}개</summary>
          {!completedRows.length && <p className="worktrail-meta">초안으로 만들 완료 기록이 없습니다.</p>}
          <div className="worktrail-picker-list" role="region" aria-label="문서로 만들 완료 작업 목록" tabIndex={0}>
          {completedRows.map(row => <label className="worktrail-check" key={row.id}>
            <input type="checkbox" checked={caseIds.includes(row.id)}
              disabled={Boolean(busy) || (caseIds.length >= 20 && !caseIds.includes(row.id))}
              onChange={event => setCaseIds(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))} />
            <span>#{row.id} · {row.title}</span></label>)}
          </div>
        </details>
        <details open={!document}><summary>저장한 문서 · {documents.length}개</summary>
          {documents.map(row => <button type="button" className="worktrail-record" key={row.id} disabled={Boolean(busy) || dirty}
            onClick={() => void chooseDocument(row.id)}><strong>{row.title}</strong><span>{documentStatuses[row.status]}</span></button>)}
          {!documents.length && <p className="worktrail-meta">저장한 초안이 없습니다. 완료 작업을 선택해 주세요.</p>}
        </details>
        {document && <article className="worktrail-editor">
          <p className="worktrail-meta">{documentStatuses[document.status]}{dirty ? ' · 저장하지 않은 변경' : ''}</p>
          <label>제목<input value={title} maxLength={180} disabled={locked || Boolean(busy)}
            onChange={event => { setTitle(event.target.value); setConfirmed(false); }} /></label>
          <label>본문<textarea value={content} maxLength={200_000} rows={16} disabled={locked || Boolean(busy)}
            onChange={event => { setContent(event.target.value); setConfirmed(false); }} /></label>
          <p className="worktrail-meta">출처: {document.sources.map(source => `#${source.id} ${source.title}`).join(' · ')}</p>
          <div className="worktrail-actions">
            <button type="button" disabled={locked || !dirty || Boolean(busy)} onClick={() => void mutateDocument('save')}>문서 저장</button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(value => !value)}>미리보기</button>
            <button type="button" disabled={locked || dirty || Boolean(busy)} onClick={() => setDeleting(value => !value)}>초안 삭제</button>
          </div>
          {deleting && <div className="worktrail-delete"><p>이 PC의 초안을 삭제합니다. Worktrail 원본 기록은 유지됩니다.</p>
            <button type="button" disabled={Boolean(busy)} onClick={() => void run('초안 삭제', async () => {
              await request('remove', { id: document.id, revision: document.revision, confirm: true });
              setDocument(null); setTitle(''); setContent(''); setDeleting(false); setConfirmed(false);
              setDocuments(await request('documents'));
            })}>삭제 확인</button><button type="button" onClick={() => setDeleting(false)}>취소</button></div>}
          {preview && <Suspense fallback={<p className="worktrail-meta">미리보기 준비 중…</p>}>
            <MarkdownPreview text={content} projectPath="" relPath="worktrail-document.md" />
          </Suspense>}
          {document.error && <p className="worktrail-error">{document.error}</p>}
          <label className="worktrail-check"><input type="checkbox" checked={confirmed}
            disabled={dirty || Boolean(busy) || document.status === 'submitted'} onChange={event => setConfirmed(event.target.checked)} />
            <span>본문과 출처를 확인했습니다</span></label>
          <div className="worktrail-actions"><button type="button"
            disabled={!canSubmitDocument(document, dirty, confirmed) || Boolean(busy)} onClick={() => void mutateDocument('submit')}>
            {document.status === 'sending' || document.status === 'uncertain' ? '상태 확인·재시도' : 'CloudWiki 승인 요청'}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void run('CloudWiki 연결 확인', async () => {
              try {
                const value = await request('wiki-status'); setWikiConnection(`CloudWiki 연결됨 · 승인 대기 ${value.pending}개`);
              } catch (problem) { setWikiConnection('CloudWiki 연결 확인 필요'); throw problem; }
            })}>연결 확인</button></div>
          <p className="worktrail-meta">{wikiConnection}</p>
          <p className="worktrail-meta">승인 대기로만 전송합니다. 최종 게시는 CloudWiki에서 승인한 뒤 진행됩니다.</p>
        </article>}
      </>}
    </div>
  </section>;
}
