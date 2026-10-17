// Presentation values match the desktop Worktrail record flow.
export const recordTypes = Object.freeze({
  decision: ['결정', 'up'], constraint: ['제약', 'up'], ruled_out: ['배제', 'up'],
  closed: ['종료', 'up'], opened: ['열림', 'up'], focus: ['초점', 'up'],
  open: ['미해결', 'up'], next: ['다음', 'up'], asked: ['질문', 'up'], term: ['용어', 'up'],
  change: ['바꿈', 'down'], verified: ['확인', 'down'], finding: ['발견', 'down'],
  thought: ['생각', 'down'],
});
export const recordLabel = (kind) => recordTypes[kind]?.[0] || '기록';
export const recordSide = (kind) => recordTypes[kind]?.[1] || 'down';
export const recentRecords = (records) => records.slice(-6);
