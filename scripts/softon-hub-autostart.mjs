import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SLACK_PROJECT_CWD } from '../src/integrations/slack-session/project.mjs';
import { allowedAddress } from '../src/integrations/slack-session/hub/access.mjs';

export async function startHubAtLogon({ probeDaemon, launchApp, startBridge, probeHub,
  record, sleep = delay, now = Date.now, timeoutMs = 120_000 }) {
  const deadline = now() + timeoutMs;
  const until = async (check, label) => {
    while (now() < deadline) {
      if (await check()) return;
      await sleep(500);
    }
    throw new Error(`${label} 준비 시간을 초과했습니다.`);
  };
  await record('starting');
  if (!await probeDaemon()) {
    await launchApp();
    await until(probeDaemon, 'Mixdog 데몬');
  }
  await record('daemon-ready');
  await startBridge(Math.max(1, deadline - now()));
  await until(probeHub, 'SOFTON HTTPS');
  await record('ready');
  return { ready: true };
}

function launch(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, ...options });
    child.once('error', reject);
    if (options.detached) child.once('spawn', () => { child.unref(); resolve(); });
    else child.once('exit', (code, signal) => code === 0 ? resolve()
      : reject(new Error(`시작 명령 실패: ${path.basename(executable)} (${code ?? signal})`)));
  });
}

function probeHttps(origin, ca) {
  return new Promise((resolve, reject) => {
    const request = https.get(new URL('/api/me', origin), { ca, timeout: 3000, agent: false }, (response) => {
      response.resume();
      if (response.statusCode === 401) resolve(true);
      else reject(new Error(`공유실 인증 경계의 상태가 올바르지 않습니다: ${response.statusCode}`));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('HTTPS readiness timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => {
      if (['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH'].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
}

async function main() {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, 'tls-cert': { type: 'string' } } });
  const origin = new URL(values.origin);
  if (origin.protocol !== 'https:' || !allowedAddress(origin.hostname) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || !path.isAbsolute(values['tls-cert'] || '')) {
    throw new Error('사내망 HTTPS 주소와 공개 인증서의 절대 경로가 필요합니다.');
  }
  const local = process.env.LOCALAPPDATA;
  if (!local || !path.isAbsolute(local)) throw new Error('Windows 사용자 프로필 경로를 확인할 수 없습니다.');
  const profile = path.join(local, 'mixdog-dev', 'personal');
  process.env.MIXDOG_RUNTIME_ROOT = path.join(profile, 'runtime');
  process.env.MIXDOG_HOME = path.join(profile, 'home');
  process.env.MIXDOG_DATA_DIR = path.join(profile, 'data');
  const api = await import('../src/standalone/session-client.mjs');
  const executable = path.join(local, 'Programs', 'mixdog-personal', 'Mixdog Personal.exe');
  const receipt = path.join(local, 'SOFTON', 'session-hub', 'startup.json');
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  const record = (status, error) => fs.writeFile(receipt,
    JSON.stringify({ status, at: new Date().toISOString(), origin: origin.origin, error: error || undefined }, null, 2));
  try {
    const ca = await fs.readFile(values['tls-cert']);
    await startHubAtLogon({
      record,
      probeDaemon: async () => {
        const discovery = api.readSessionDiscovery();
        if (!discovery) return false;
        const health = await api.probeSessionHealth(discovery);
        if (!health) return false;
        const compatibility = api.sessionDaemonCompatibility(health);
        if (!['compatible', 'daemon-newer'].includes(compatibility.status)) {
          throw new Error('설치된 Mixdog 런타임이 공유실 코드와 호환되지 않습니다.');
        }
        return health.status === 'ok';
      },
      launchApp: () => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        return launch(executable, ['--softon-hub-background'], { detached: true, stdio: 'ignore', cwd: SLACK_PROJECT_CWD, env });
      },
      startBridge: (timeout) => launch(path.join(process.env.SystemRoot, 'System32', 'wsl.exe'),
        ['-d', 'Ubuntu', '-u', 'namidainfo', '--exec', 'systemctl', '--user', 'start', 'codex-slack-bridge.service'],
        { stdio: 'ignore', timeout }),
      probeHub: () => probeHttps(origin, ca),
    });
  } catch (error) {
    await record('failed', error.message);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
