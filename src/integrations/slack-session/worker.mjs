import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { HubWorkerBridge } from './hub/worker-bridge.mjs';

export async function runSlackWorker(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      'runtime-root': { type: 'string' },
      provider: { type: 'string', default: 'openai-oauth' },
      model: { type: 'string', default: 'gpt-6.1-sol' },
      effort: { type: 'string', default: 'ultra' },
      'context-tokens': { type: 'string', default: '500000' },
      'max-attachment-bytes': { type: 'string', default: String(20 * 1024 * 1024) },
    },
  });
  if (!values['runtime-root']) throw new Error('runtime-root가 필요합니다.');
  process.env.MIXDOG_RUNTIME_ROOT = values['runtime-root'];
  const { NativeSlackClient } = await import('./native-client.mjs');
  let writes = Promise.resolve();
  const send = (message) => {
    writes = writes.then(() => new Promise((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    }));
    writes.catch(() => {});
    return writes;
  };
  const hubBridge = new HubWorkerBridge(send);
  const client = new NativeSlackClient({
    hubBridge,
    provider: values.provider,
    model: values.model,
    effort: values.effort,
    contextTokens: Number(values['context-tokens']),
    maxAttachmentBytes: Number(values['max-attachment-bytes']),
    onState: (event) => void send({ event: 'state', ...event }),
    log: (message) => process.stderr.write(`[mixdog-slack] ${message}\n`),
  });
  const methods = new Set(['health', 'open', 'state', 'submit', 'context', 'abort', 'approve', 'answer', 'stageFiles', 'release', 'hubSnapshot', 'hubFile', 'startHub', 'stopHub']);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const running = new Set();
  input.on('line', (line) => {
    const task = (async () => {
      let request;
      try {
        request = JSON.parse(line);
        if (request.method === 'hubReply' && typeof request.id === 'string') {
          hubBridge.receive(request.id, request.params);
          return;
        }
        if (typeof request.id !== 'string' || !methods.has(request.method)) throw new Error('허용되지 않은 worker 요청입니다.');
        const result = await client[request.method](request.params || {});
        await send({ id: request.id, ok: true, result });
      } catch (error) {
        await send({ id: request?.id || '', ok: false, error: String(error.message) });
      }
    })();
    running.add(task);
    void task.finally(() => running.delete(task)).catch(() => {});
  });
  await new Promise((resolve) => input.once('close', resolve));
  hubBridge.close();
  await Promise.allSettled(running);
  await client.close();
  await writes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSlackWorker().catch((error) => {
    process.stderr.write(`[mixdog-slack] ${error.message}\n`);
    process.exitCode = 1;
  });
}
