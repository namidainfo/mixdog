import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionTabProject } from './session-tab-project.ts';

const projects = [
  { path: 'C:\\work\\alpha', name: 'alpha', alias: 'Migration' },
  { path: 'C:\\work\\beta', name: 'beta', alias: 'Other project' },
];

test('session tab uses its own project alias and full working directory', () => {
  assert.deepEqual(sessionTabProject('Discussion', {
    projectPath: 'c:/work/alpha/',
    cwd: 'C:\\work\\alpha\\src',
  }, projects, '미분류'), {
    title: '[Migration] Discussion',
    tooltip: 'Migration\nC:\\work\\alpha\\src\nDiscussion',
  });
});

test('unclassified sessions do not inherit a registered project', () => {
  assert.deepEqual(sessionTabProject('Hello', {
    projectPath: null, cwd: 'C:\\workspace\\unclassified',
  }, projects, '미분류'), {
    title: '[미분류] Hello',
    tooltip: '미분류\nC:\\workspace\\unclassified\nHello',
  });
});

test('project names and removed-project paths remain distinguishable', () => {
  assert.equal(sessionTabProject('Task', { projectPath: '/work/old', cwd: '/work/old' }, [], '미분류').title, '[old] Task');
  assert.equal(sessionTabProject('Task', { projectPath: '/work/repo' }, [
    { path: '/work/repo', name: 'Repository', alias: null },
  ], '미분류').title, '[Repository] Task');
});

test('POSIX projects keep case distinctions and updated aliases are reflected', () => {
  const session = { projectPath: '/work/Repo', cwd: '/work/Repo' };
  assert.equal(sessionTabProject('Task', session, [
    { path: '/work/repo', name: 'Wrong', alias: 'Wrong' },
  ], '미분류').title, '[Repo] Task');
  assert.equal(sessionTabProject('Task', session, [
    { path: '/work/Repo', name: 'Repo', alias: 'Renamed' },
  ], '미분류').title, '[Renamed] Task');
});

test('missing session metadata does not borrow the active project', () => {
  assert.equal(sessionTabProject('Loading', undefined, projects, '미분류').title, '[미분류] Loading');
});
