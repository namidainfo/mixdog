import type { WorktrailCase, WorktrailDocument, WorktrailReview } from '../../shared/worktrail-contract';

export const documentStatuses: Record<WorktrailDocument['status'], string> = {
  draft: '작성 중', sending: '전송 결과 확인 필요', uncertain: '전송 결과 확인 필요', submitted: 'CloudWiki 승인 대기',
};
export function completedCase(state: string): boolean {
  return ['closed', 'resolved', 'completed'].includes(state);
}
export function worktrailRows(review: WorktrailReview | null): Array<WorktrailCase & { id: number; topic: string }> {
  const topics = new Map<number, string>();
  for (const topic of review?.topics ?? []) for (const id of topic.case_ids) topics.set(id, topic.name);
  return Object.entries(review?.cases ?? {}).map(([id, row]) => ({
    ...row, id: Number(id), topic: topics.get(Number(id)) ?? '주제 없음',
  })).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || b.id - a.id);
}
export function documentDirty(document: WorktrailDocument | null, title: string, content: string): boolean {
  return Boolean(document && (title !== document.title || content !== document.content));
}
export function canSubmitDocument(document: WorktrailDocument | null, dirty: boolean, confirmed: boolean): boolean {
  return Boolean(document && document.status !== 'submitted' && !dirty && confirmed);
}
