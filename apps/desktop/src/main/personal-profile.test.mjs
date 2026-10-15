import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { certificate, privateKey } from '../../../../src/runtime/shared/llm/http-agent-tls-fixture.mjs';

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./personal-profile.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['electron'],
});
const profileCode = bundled.outputFiles[0].text;

function runProfile({ packaged = true, name = 'mixdog-personal', version = '1.2.0-personal.1', platform = 'win32', env = {}, tlsModule } = {}) {
  const environment = {
    LOCALAPPDATA: process.env.LOCALAPPDATA || tmpdir(),
    MIXDOG_DATA_DIR: 'inherited-data',
    HTTPS_PROXY: 'https://proxy.example.invalid:443',
    NODE_EXTRA_CA_CERTS: 'existing-extra-ca.pem',
    ...env,
  };
  const original = { ...environment };
  let applied;
  const certificates = tlsModule || {
    getCACertificates: type => type === 'default' ? ['existing-default-ca'] : ['windows-ca'],
    setDefaultCACertificates: certs => { applied = Array.from(certs); },
  };
  runInNewContext(profileCode, {
    process: { platform, env: environment },
    require(id) {
      if (id === 'electron') return { app: { isPackaged: packaged, getName: () => name, getVersion: () => version } };
      if (id === 'node:tls') return certificates;
      return require(id);
    },
  });
  return { environment, original, applied };
}

test('Windows personal profile adds system trust without replacing existing roots or weakening TLS', () => {
  const { environment, applied } = runProfile();
  assert.deepEqual(applied, ['existing-default-ca', 'windows-ca']);
  assert.equal(environment.NODE_USE_SYSTEM_CA, '1');
  assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(environment.NODE_EXTRA_CA_CERTS, 'existing-extra-ca.pem');
  assert.equal(environment.HTTPS_PROXY, 'https://proxy.example.invalid:443');
  assert.equal(environment.MIXDOG_PERSONAL, '1');
  assert.equal(environment.MIXDOG_PERSONAL_VERSION, '1.2.0-personal.1');
  assert.equal(environment.MIXDOG_OAUTH_TLS_DIAGNOSTICS, '0');
  assert.equal(environment.MIXDOG_DATA_DIR, join(environment.LOCALAPPDATA, 'mixdog-dev', 'personal', 'data'));
});

test('official packaged app does not change CA trust or its environment', () => {
  const { environment, original, applied } = runProfile({ name: 'mixdog-desktop' });
  assert.deepEqual(environment, original);
  assert.equal(applied, undefined);
});

test('development app does not activate the packaged personal profile', () => {
  const { environment, original, applied } = runProfile({ packaged: false });
  assert.deepEqual(environment, original);
  assert.equal(applied, undefined);
});

test('non-Windows personal profile retains its existing TLS configuration', () => {
  const { environment, applied } = runProfile({ platform: 'linux' });
  assert.equal(applied, undefined);
  assert.equal(environment.NODE_USE_SYSTEM_CA, undefined);
  assert.equal(environment.MIXDOG_PERSONAL, '1');
});

test('system CA addition enables trusted TLS while hostname verification remains enforced', async t => {
  const original = tls.getCACertificates('default');
  t.after(() => tls.setDefaultCACertificates(original));
  const fingerprint = new X509Certificate(certificate).fingerprint256;
  assert.equal(original.some(pem => new X509Certificate(pem).fingerprint256 === fingerprint), false);
  const server = tls.createServer({ cert: certificate, key: privateKey }, socket => socket.end());
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connect = servername => new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: server.address().port,
      ...(servername ? { servername } : {}),
    });
    socket.once('error', reject);
    socket.once('secureConnect', () => { socket.end(); resolve(socket.authorized); });
    socket.setTimeout(3000, () => socket.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  });
  await assert.rejects(connect(), error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
  runProfile({
    tlsModule: {
      getCACertificates: type => type === 'system' ? [certificate] : tls.getCACertificates(type),
      setDefaultCACertificates: certs => tls.setDefaultCACertificates(certs),
    },
  });
  assert.equal(await connect(), true);
  await assert.rejects(connect('wrong-host.example.invalid'), error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('inherited startup setting adds system CA roots in a separate daemon runtime', () => {
  const { environment } = runProfile();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { X509Certificate } from 'node:crypto';
    import { getCACertificates } from 'node:tls';
    const defaults = new Set(getCACertificates('default').map(pem => new X509Certificate(pem).fingerprint256));
    for (const type of ['bundled', 'system']) {
      for (const pem of getCACertificates(type)) {
        assert.ok(defaults.has(new X509Certificate(pem).fingerprint256), type + ' root missing from default trust');
      }
    }
  `], {
    env: { ...process.env, NODE_USE_SYSTEM_CA: environment.NODE_USE_SYSTEM_CA },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
