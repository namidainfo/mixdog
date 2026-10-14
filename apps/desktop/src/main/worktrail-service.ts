import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { WorktrailAction, WorktrailDocument } from '../shared/worktrail-contract';
import { createWorktrailClient, createWorktrailDocuments, createWorktrailSearch } from './worktrail/worktrail-core.mjs';
import cloudwikiRunner from './worktrail/cloudwiki-runner.mjs';

export function runCloudWiki(action: 'status' | 'submit', input: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('C:\\Windows\\System32\\wsl.exe', [
      '-d', 'Ubuntu', '-u', 'namidainfo', '--exec', 'bash', '-c',
      'export PATH="$HOME/.hermes/node/bin:$HOME/.local/bin:$PATH"; exec node --input-type=module -e "$1" -- --worktrail-cloudwiki',
      'worktrail-cloudwiki', cloudwikiRunner,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', diagnostic = '', settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('CloudWiki 응답이 늦습니다. 같은 문서로 상태 확인·재시도해 주세요.'));
    }, action === 'submit' ? 75_000 : 30_000);
    child.on('error', () => finish(new Error('WSL CloudWiki 연결을 시작하지 못했습니다.')));
    child.stdin.on('error', () => finish(new Error('WSL CloudWiki 요청을 전달하지 못했습니다.')));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(0, 2_000);
    });
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 2_000_000) {
        child.kill();
        finish(new Error('CloudWiki 응답 크기를 확인해 주세요.'));
      }
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const receipt = JSON.parse(output) as { error?: string; result?: unknown };
        if (code !== 0 || receipt.error) finish(new Error(receipt.error || 'CloudWiki 연결에 실패했습니다.'));
        else if (!receipt.result) finish(new Error('CloudWiki 결과를 확인하지 못했습니다.'));
        else finish(undefined, receipt.result);
      } catch {
        const reason = diagnostic.trim().split(/\r?\n/u)[0]?.slice(0, 500);
        finish(new Error(`WSL CloudWiki 요청기 실행 실패 (${code ?? 'unknown'})${reason ? `: ${reason}` : '. 연결 결과를 확인하지 못했습니다.'}`));
      }
    });
    child.stdin.end(JSON.stringify({ action, input }));
  });
}

export async function createWorktrailService({
  directory, request = fetch, wiki = runCloudWiki,
}: {
  directory: string;
  request?: typeof fetch;
  wiki?: (action: 'status' | 'submit', input?: Record<string, unknown>) => Promise<unknown>;
}) {
  const file = join(directory, 'worktrail-documents.json');
  let rows: WorktrailDocument[] = [];
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(saved) || saved.some(row => !row || typeof row.id !== 'string'
      || typeof row.content !== 'string' || !['draft', 'sending', 'uncertain', 'submitted'].includes(row.status)))
      throw new Error('저장된 Worktrail 문서 형식을 확인해 주세요. 원본 파일은 보존됩니다.');
    rows = saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const store = {
    getSetting: () => structuredClone(rows),
    async setSetting(_key: string, value: WorktrailDocument[]) {
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
        rows = structuredClone(value);
      } finally { await rm(temporary, { force: true }); }
    },
  };
  const worktrail = createWorktrailClient(request);
  const search = createWorktrailSearch({ load: options => worktrail.review(options) });
  const documents = createWorktrailDocuments({
    store, worktrail, bridge: { call: (_name, input) => wiki('submit', input) },
  });
  const handlers: Record<WorktrailAction, (input: Record<string, unknown>) => unknown> = {
    status: () => worktrail.status(),
    review: () => worktrail.review(),
    thread: input => worktrail.thread(input.id as number),
    history: input => worktrail.history(input.id as number),
    search: input => search.search(input),
    archive: input => worktrail.archive(input.id as number | undefined),
    prior: input => worktrail.prior(input.id as number),
    documents: () => documents.list(),
    document: input => documents.get(input.id as string),
    create: input => documents.create(input),
    save: input => documents.save(input),
    remove: input => documents.remove(input),
    submit: input => documents.submit(input),
    'wiki-status': () => wiki('status'),
  };
  return {
    async invoke(action: unknown, input: unknown = {}) {
      if (typeof action !== 'string' || !Object.hasOwn(handlers, action)
        || !input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Worktrail 작업을 확인해 주세요.');
      return handlers[action as WorktrailAction](input as Record<string, unknown>);
    },
  };
}
