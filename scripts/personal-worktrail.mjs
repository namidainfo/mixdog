import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createPersistentDevEnv, persistentDevProfileDir } from '../apps/desktop/scripts/dev-profile.mjs';

export const WORKTRAIL_SERVER = Object.freeze({
  name: 'worktrail',
  type: 'stdio',
  command: 'C:\\Windows\\System32\\wsl.exe',
  args: ['-d', 'Ubuntu', '-u', 'namidainfo', '--', '/home/namidainfo/.local/bin/worktrail-mcp'],
});

export const WORKTRAIL_RECORDING = `
## Worktrail automatic work recording

Record development, configuration changes, troubleshooting and investigation
without asking for approval for each record. Exclude greetings and conversations
with no work outcome. Never copy the entire conversation.

At task start, discover the Worktrail MCP tools and call list_threads with the
actual worktree path. Resume a matching task or open_thread for a new objective.
Reuse a matching topic; create one only when needed. Keep the returned case_id.
Identify the source as Mixdog Personal in the record, without inventing tool fields.

After meaningful changes, findings or checks, use note_turn to record observations,
judgment, next action and owner. Distinguish requested work from work actually done.
Avoid duplicate notes for unchanged results. Use decide for user decisions and
declare or next for unfinished work. Use add_evidence only for genuine source
evidence, not summaries presented as quotations.

Before the final answer, record changes, verification and remaining limitations.
Close with close_thread(result=...) only if complete. Otherwise keep the task open
with next action and owner. Use handoff only when the user requests a handoff.
Use a short first-line title (at most 120 display columns) and a blank line before
details. Check both isError and error messages in the response; claim recording
success only after a confirmed successful save.

Never record passwords, tokens, cookies, private keys, full environment dumps or
private conversation transcripts. Do not automatically approve Knowledge Promoter
candidates or publish wiki content. If connection or storage fails, retry once
only when permitted by the active retry policy; otherwise continue the task and
clearly report the recording failure. Do not claim this instruction-based process
guarantees lossless recording through crashes or cancellation.
`;

export async function configureWorktrail(execute, baseWorkflow) {
  const call = async (args) => {
    const response = await execute(args);
    const value = typeof response === 'string' ? JSON.parse(response) : response;
    if (value?.isError || value?.error) throw new Error('Worktrail setup failed; inspect the setup response.');
    return value;
  };
  const status = await call({ action: 'status', domain: 'mcp' });
  if (status.servers?.some((server) => server.name === 'worktrail')) {
    throw new Error('A worktrail MCP server already exists. Review it in Settings before changing it.');
  }
  // Use supported setup actions, never write the profile config/store directly.
  await call({ action: 'add_mcp_server', server: WORKTRAIL_SERVER });
  await call({
    action: 'create_definition',
    definitionKind: 'workflow',
    definition: {
      id: 'personal-worktrail',
      name: 'Personal Worktrail',
      description: 'Default approval workflow with Worktrail work recording.',
      body: `${baseWorkflow.trim()}\n\n${WORKTRAIL_RECORDING.trim()}`,
    },
  });
  return call({ action: 'set_workflow', workflow: 'personal-worktrail' });
}

async function main() {
  const profile = persistentDevProfileDir('personal');
  if (process.argv[2] !== '--isolated-child') {
    const env = await createPersistentDevEnv(process.env, profile);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child'], {
      env, stdio: 'inherit',
    });
    process.exitCode = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => accept(code ?? 1));
    });
    return;
  }
  if (resolve(process.env.MIXDOG_HOME || '.') !== resolve(join(profile, 'home'))
      || resolve(process.env.MIXDOG_DATA_DIR || '.') !== resolve(join(profile, 'data'))) {
    throw new Error('Worktrail provisioning is restricted to the isolated personal profile.');
  }
  const [{ createMixdogSessionRuntime }, { createSetupToolExecutor }] = await Promise.all([
    import('../src/mixdog-session-runtime.mjs'),
    import('../src/session-runtime/setup-tool/executor.mjs'),
  ]);
  const source = await readFile(new URL('../src/workflows/default/WORKFLOW.md', import.meta.url), 'utf8');
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const runtime = await createMixdogSessionRuntime();
  const setup = createSetupToolExecutor({ getApi: () => runtime });
  try {
    const receipt = await configureWorktrail((args) => setup.execute(args), body);
    console.log(JSON.stringify({ profile, receipt, note: 'Configuration only; no work record was created.' }, null, 2));
  } finally {
    setup.dispose();
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
