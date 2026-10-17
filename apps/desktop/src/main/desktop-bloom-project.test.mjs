import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopSessionSummaries } from './desktop-state';

const metadata = { classification: 'project', projectPath: 'C:\\Users\\me\\Documents\\Bloom', source: 'bloom', purpose: 'chat' };

test('Bloom grouping does not retarget the execution project or worktree', () => {
  const rows = [
    { id: 'bloom', title: '260102-007 | [Bloom] 요청', cwd: 'C:\\actual\\project', desktopSession: metadata },
    {
      id: 'worktree', title: '260102-008 | [Bloom] 다른 요청', cwd: 'C:\\worktrees\\fix',
      desktopSession: { ...metadata, purpose: 'work' },
      workspace: { projectPath: 'C:\\actual\\project', cwd: 'C:\\worktrees\\fix', branch: 'fix', worktreeId: 'fix' },
    },
  ];
  const before = structuredClone(rows);
  const result = desktopSessionSummaries(rows);
  assert.equal(result.length, 2);
  for (const summary of result) assert.equal(summary.projectPath, metadata.projectPath);
  assert.equal(result[0].cwd, 'C:\\actual\\project');
  assert.equal(result[1].cwd, 'C:\\worktrees\\fix');
  assert.deepEqual(rows, before);
});

test('gateway helpers are hidden and automatic requests are identified under Bloom', () => {
  const result = desktopSessionSummaries([
    { id: 'gateway', title: 'Internal', cwd: 'C:\\actual', messageCount: 4, desktopSession: { ...metadata, purpose: 'gateway' } },
    { id: 'automatic', title: '260102-009 | [Bloom·자동] 요청 추출', cwd: 'C:\\actual', desktopSession: { ...metadata, purpose: 'structured-text' } },
  ]);
  assert.deepEqual(result.map((row) => row.id), ['automatic']);
  assert.equal(result[0].projectPath, metadata.projectPath);
  assert.match(result[0].title, /\[Bloom·자동\]/);
});

test('Bloom manual names win and unrelated sessions keep their execution grouping', () => {
  const result = desktopSessionSummaries([
    { id: 'manual', title: 'Automatic', cwd: 'C:\\actual', desktopSession: metadata },
    { id: 'normal', title: 'Normal', cwd: 'C:\\actual', desktopSession: { classification: 'project', projectPath: 'C:\\stale' } },
  ], {}, { manual: '직접 정한 이름' });
  assert.equal(result[0].title, '직접 정한 이름');
  assert.equal(result[0].projectPath, metadata.projectPath);
  assert.equal(result[1].projectPath, 'C:\\actual');
});
