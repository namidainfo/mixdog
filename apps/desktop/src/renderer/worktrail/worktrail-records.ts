/** Worktrail count-axis/event presentation adapted from Project Workdesk's
 * personal/internal Worktrail view. */
import type { WorktrailEvent, WorktrailReview } from '../../shared/worktrail-contract';
import { worktrailRows } from './worktrail-model';

export interface WorktrailRecord extends WorktrailEvent {
  key: string;
  caseId: number;
  title: string;
}

const labels: Record<string, string> = {
  decision: '결정', constraint: '제약', ruled_out: '배제', closed: '종료', opened: '열림',
  focus: '초점', open: '미해결', next: '다음', asked: '질문', term: '용어', commit: '커밋',
  change: '바꿈', verified: '확인', finding: '발견', thought: '생각', note: '기록',
};
const colors: Record<string, string> = {
  decision: '#fab387', constraint: '#f38ba8', ruled_out: '#eba0ac', closed: '#a8a8a8',
  opened: '#c8d0d8', asked: '#fab387', commit: '#f9e2af', change: '#89b4fa',
  verified: '#a6e3a1', finding: '#cba6f7', thought: '#9399b2',
};
const directions = new Set(['decision', 'constraint', 'ruled_out', 'closed', 'opened', 'focus', 'open', 'next', 'asked', 'term']);
export const recordMillis = (at?: number): number => at ? (at < 1e12 ? at * 1000 : at) : 0;
export const worktrailStamp = (at?: number): string => at ? new Date(recordMillis(at)).toLocaleString('ko-KR') : '';
export const recordKind = (record: WorktrailEvent): string => record.kind === 'note' ? record.note_kind || 'thought' : record.kind || 'note';
export const recordLabel = (record: WorktrailEvent): string => labels[recordKind(record)] || '기록';
export const recordColor = (record: WorktrailEvent): string => colors[recordKind(record)] || '#a8a8a8';
export const recordSide = (record: WorktrailEvent): 'up' | 'down' => directions.has(recordKind(record)) ? 'up' : 'down';
export const recordHeading = (record: WorktrailEvent): string =>
  (record.observed || record.text || '내용 없음').split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '') || '내용 없음';

export function worktrailRecords(review: WorktrailReview | null): WorktrailRecord[] {
  return worktrailRows(review).flatMap(row => row.events.map((event, index) => ({
    ...event, caseId: row.id, title: row.title, key: `${row.id}:${index}:${event.kind || 'note'}:${event.at ?? 0}`,
  }))).sort((a, b) => recordMillis(a.at) - recordMillis(b.at));
}
