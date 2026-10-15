import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { recordColor, recordHeading, recordLabel, recordSide, worktrailStamp, type WorktrailRecord } from './worktrail-records';

const markStyle = (record: WorktrailRecord): CSSProperties =>
  ({ '--worktrail-mark-color': recordColor(record) }) as CSSProperties;

export function WorktrailRecordFlow({ records, selected, selectedRecord, onSelect }: {
  records: readonly WorktrailRecord[];
  selected: number | null;
  selectedRecord: string | null;
  onSelect(record: WorktrailRecord): void;
}) {
  const [peekKey, setPeekKey] = useState<string | null>(selectedRecord);
  const tooltipId = useId();
  useEffect(() => { setPeekKey(selectedRecord); }, [selectedRecord]);
  const latest = records.slice(-6);
  const peek = latest.find(record => record.key === peekKey);
  if (!latest.length) return null;
  return <section className="worktrail-flow" aria-label="최근 기록 흐름">
    <div className="worktrail-flow-heading"><h3>최근 기록 흐름</h3><span className="worktrail-meta">기록 순서 기준 · 최근 {latest.length}개</span></div>
    <div className="worktrail-flow-track">
      <span className="worktrail-flow-lane up">방향</span>
      <div className="worktrail-flow-marks" style={{ gridTemplateColumns: `repeat(${latest.length}, minmax(44px, 1fr))` }}>
        {latest.map(record => <button type="button" className="worktrail-flow-mark" key={record.key} style={markStyle(record)}
          data-here={selected == null || selected === record.caseId} aria-pressed={selectedRecord === record.key}
          aria-label={`${recordLabel(record)} · ${recordHeading(record)} · #${record.caseId} ${record.title} · ${worktrailStamp(record.at) || '시각 없음'}`}
          aria-describedby={peek?.key === record.key ? tooltipId : undefined}
          onPointerEnter={() => setPeekKey(record.key)} onPointerLeave={() => setPeekKey(null)}
          onFocus={() => setPeekKey(record.key)} onBlur={() => setPeekKey(null)}
          onKeyDown={event => { if (event.key === 'Escape') setPeekKey(null); }}
          onClick={() => onSelect(record)}>
          <span className={`worktrail-flow-stem ${recordSide(record)}`} aria-hidden="true" />
        </button>)}
      </div>
      <span className="worktrail-flow-lane down">흔적</span>
    </div>
    <div className="worktrail-flow-axis"><span>오래된 기록</span><span>최신 기록</span></div>
    <div className="worktrail-flow-legend">{['decision', 'change', 'verified', 'finding'].map(kind =>
      <span key={kind} style={markStyle({ kind } as WorktrailRecord)}><i className="worktrail-record-dot" aria-hidden="true" />{recordLabel({ kind })}</span>)}</div>
    <p className="worktrail-meta">간격은 경과 시간이 아닙니다. 막대를 선택하면 해당 작업과 기록을 표시합니다.</p>
    {peek && <div className="worktrail-flow-peek" role="tooltip" id={tooltipId} style={markStyle(peek)}>
      <p className="worktrail-meta"><span>{recordLabel(peek)}</span> · {worktrailStamp(peek.at) || '시각 없음'}</p>
      <strong>{recordHeading(peek)}</strong><p className="worktrail-meta">#{peek.caseId} · {peek.title}</p>
    </div>}
  </section>;
}

export function WorktrailRecentRecords({ records, selectedRecord, selectionSequence }: {
  records: readonly WorktrailRecord[];
  selectedRecord: string | null;
  selectionSequence: number;
}) {
  const nodes = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const node = selectedRecord ? nodes.current.get(selectedRecord) : undefined;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest' });
  }, [selectedRecord, selectionSequence]);
  return <section aria-label="선택 작업의 최근 기록" className="worktrail-recent">
    <h4>선택 작업의 최근 기록</h4>
    {!records.length && <p className="worktrail-meta">최근 조회 내용에 이 작업의 기록이 없습니다. 전체 기록에서 확인해 주세요.</p>}
    <div className="worktrail-recent-records">{records.slice().reverse().map(record =>
      <article className="worktrail-recent-record" key={record.key} tabIndex={0} style={markStyle(record)}
        data-current={selectedRecord === record.key}
        ref={node => { if (node) nodes.current.set(record.key, node); else nodes.current.delete(record.key); }}>
        <p className="worktrail-meta"><i className="worktrail-record-dot" aria-hidden="true" />{recordLabel(record)} · {worktrailStamp(record.at) || '시각 없음'}</p>
        <p>{recordHeading(record)}</p>
        <details open={selectedRecord === record.key}><summary>기록 내용</summary>
          <p className="worktrail-pre">{record.observed || record.text || '내용 없음'}</p>
          {record.reason && <p className="worktrail-pre">{record.reason}</p>}
        </details>
      </article>)}</div>
  </section>;
}
