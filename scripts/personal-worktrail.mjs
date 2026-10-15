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

export async function configureWorktrail(execute, defaultWorkflow) {
  const call = async (args) => {
    const response = await execute(args);
    const value = typeof response === 'string' ? JSON.parse(response) : response;
    if (value?.isError || value?.error) throw new Error('Worktrail setup failed; inspect the setup response.');
    return value;
  };
  const status = await call({ action: 'status', domain: 'mcp' });
  // Use supported setup actions, never write the profile config/store directly.
  if (!status.servers?.some((server) => server.name === 'worktrail')) {
    await call({ action: 'add_mcp_server', server: WORKTRAIL_SERVER });
  }
  await call({
    action: 'save_definition',
    definitionKind: 'workflow',
    definition: {
      id: 'default',
      name: 'Default',
      description: 'Default approval workflow.',
      body: defaultWorkflow.trim(),
    },
  });
  return call({ action: 'set_workflow', workflow: 'default' });
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
