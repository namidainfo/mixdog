import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { WorktrailAction, WorktrailDocument } from '../shared/worktrail-contract';
import { createWorktrailClient, createWorktrailDocuments, createWorktrailSearch } from './worktrail/worktrail-core.mjs';
import { runCloudWiki } from '../../../../src/integrations/cloudwiki/bridge.mjs';
export { runCloudWiki };

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
