import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorktrailToolArguments } from './worktrail-input.mjs';

const cfg = {
  type: 'stdio',
  command: 'C:\\Windows\\System32\\wsl.exe',
  args: ['-d', 'Ubuntu', '-u', 'namidainfo', '--', '/home/namidainfo/.local/bin/worktrail-mcp'],
  env_vars: [],
  timeoutMs: 2000,
};
const windowsPath = 'C:\\Users\\admin\\Documents\\mixdog-personal';
const linuxPath = '/mnt/c/Users/admin/Documents/mixdog-personal';

test('Windows worktree uses the configured WSL distro and user without launching the server again', async () => {
  const calls = [];
  const controller = new AbortController();
  const args = Object.freeze({ worktree: windowsPath, focus: `Keep ${windowsPath} verbatim in the note` });
  const result = await normalizeWorktrailToolArguments('worktrail', cfg, args, {
    platform: 'win32',
    signal: controller.signal,
    run: async (command, argv, options) => {
      calls.push({ command, argv, options });
      return { stdout: `${linuxPath}\n` };
    },
  });
  assert.equal(result.worktree, linuxPath);
  assert.equal(result.focus, args.focus);
  assert.equal(args.worktree, windowsPath);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, cfg.command);
  assert.deepEqual(calls[0].argv, [
    '-d', 'Ubuntu', '-u', 'namidainfo', '--exec', 'wslpath', '-u',
    'C:/Users/admin/Documents/mixdog-personal',
  ]);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.timeout, cfg.timeoutMs);
});

test('equivalent worktree and client-facts paths are converted once without mutating git facts', async () => {
  let calls = 0;
  const facts = Object.freeze({
    worktree: 'C:/Users/admin/Documents/mixdog-personal',
    identity: 'github.com/namidainfo/mixdog',
    branch: 'personal',
    aliases: [],
  });
  const args = Object.freeze({ worktree: windowsPath, facts });
  const result = await normalizeWorktrailToolArguments('worktrail', cfg, args, {
    platform: 'win32',
    run: async () => { calls++; return { stdout: linuxPath }; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { worktree: linuxPath, facts: { ...facts, worktree: linuxPath } });
  assert.equal(facts.worktree, 'C:/Users/admin/Documents/mixdog-personal');
});

for (const separator of ['--', '--exec', '-e']) {
  test(`WSL command separator ${separator} retains the target profile`, async () => {
    const result = await normalizeWorktrailToolArguments('worktrail', {
      ...cfg,
      args: ['--distribution', 'Ubuntu', '--user', 'namidainfo', separator, '/home/namidainfo/.local/bin/worktrail-mcp'],
    }, { worktree: windowsPath }, {
      platform: 'win32',
      run: async (_command, argv) => {
        assert.deepEqual(argv.slice(0, 7), [
          '--distribution', 'Ubuntu', '--user', 'namidainfo', '--exec', 'wslpath', '-u',
        ]);
        return { stdout: linuxPath };
      },
    });
    assert.equal(result.worktree, linuxPath);
  });
}

for (const [label, name, config, args, platform] of [
  ['another MCP server', 'rea', cfg, { worktree: windowsPath }, 'win32'],
  ['a native stdio server', 'worktrail', { ...cfg, command: 'node.exe' }, { worktree: windowsPath }, 'win32'],
  ['an HTTP server', 'worktrail', { type: 'http', url: 'http://127.0.0.1:8795/mcp' }, { worktree: windowsPath }, 'win32'],
  ['a Linux client', 'worktrail', cfg, { worktree: windowsPath }, 'linux'],
  ['an already translated path', 'worktrail', cfg, { worktree: linuxPath }, 'win32'],
  ['arguments without a worktree', 'worktrail', cfg, { case_id: 190 }, 'win32'],
]) {
  test(`${label} keeps its original arguments`, async () => {
    const result = await normalizeWorktrailToolArguments(name, config, args, {
      platform,
      run: async () => { assert.fail('No WSL conversion is needed'); },
    });
    assert.equal(result, args);
  });
}

test('missing WSL command boundary fails without running a conversion', async () => {
  await assert.rejects(normalizeWorktrailToolArguments('worktrail', {
    ...cfg, args: ['-d', 'Ubuntu'],
  }, { worktree: windowsPath }, {
    platform: 'win32',
    run: async () => { assert.fail('Invalid launch arguments must not execute'); },
  }), /must separate the Linux command/);
});

test('malformed conversion output cannot be sent to Worktrail', async () => {
  await assert.rejects(normalizeWorktrailToolArguments('worktrail', cfg, { worktree: windowsPath }, {
    platform: 'win32',
    run: async () => ({ stdout: 'relative/path\n' }),
  }), /absolute Linux path/);
});

test('cancellation during conversion cannot return successfully normalized arguments', async () => {
  const controller = new AbortController();
  await assert.rejects(normalizeWorktrailToolArguments('worktrail', cfg, { worktree: windowsPath }, {
    platform: 'win32',
    signal: controller.signal,
    run: async () => { controller.abort(); return { stdout: linuxPath }; },
  }), { name: 'AbortError' });
});

test('conversion failures redact configured credentials', async () => {
  const secret = 'worktrail-test-secret';
  await assert.rejects(normalizeWorktrailToolArguments('worktrail', {
    ...cfg, env: { AUTH_TOKEN: secret },
  }, { worktree: windowsPath }, {
    platform: 'win32',
    run: async () => { throw new Error(`conversion error: ${secret}`); },
  }), (error) => {
    assert.match(error.message, /Worktrail worktree conversion failed/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});
