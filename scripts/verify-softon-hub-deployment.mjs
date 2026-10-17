import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const local = process.env.LOCALAPPDATA;
const project = 'C:/Users/admin/Documents/SOFTON';
const source = new URL('../src/integrations/slack-session/hub/', import.meta.url);
const sessionId = 'sess_daemon_1792132590793_0d2fb4aa5b1f46b6a53acde24be50258';
const origin = new URL('https://192.168.19.118:8797');
const certificate = await fs.readFile(path.join(local, 'SOFTON/session-hub/certificates/cert-vFedIU/server.crt'));
function get(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { ca: certificate, agent: false, timeout: 5000 }, (response) => {
      const parts = [];
      response.on('data', (part) => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, data: Buffer.concat(parts), type: response.headers['content-type'] }));
      response.on('error', reject);
    });
    request.once('timeout', () => request.destroy(new Error('SOFTON verification timed out')));
    request.once('error', reject);
  });
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [route, target] of [['/', 'public/index.html'], ['/app.js', 'public/app.js'],
  ['/style.css', 'public/style.css'], ['/favicon.ico', 'public/favicon.ico'], ['/favicon-32.png', 'public/favicon-32.png']]) {
  const actual = await get(new URL(route, origin)), expected = await fs.readFile(new URL(target, source));
  assert.equal(actual.status, 200, route);
  assert.equal(digest(actual.data), digest(expected), `live asset ${route}`);
}
const anonymous = await get(new URL('/api/me', origin));
assert.equal(anonymous.status, 401);
const data = path.join(local, 'mixdog-dev/personal/data');
const stored = JSON.parse(await fs.readFile(path.join(data, 'sessions', `${sessionId}.json`), 'utf8'));
const policy = stored.slackExecutionPolicy;
assert.equal(policy?.version, 1); assert.equal(policy.teamId, 'T049FKTSMK5');
assert.equal(policy.userId, 'U04BLV6HU72'); assert.equal(policy.active, true); assert.equal(policy.admin, false);
// Run with the installed Electron in Node mode so its shipped ASAR modules,
// rather than checkout code or the Bloom bridge's tiny unpacked shim, execute.
const install = path.join(local, 'Programs/mixdog-personal/resources/runtime.asar/node_modules/mixdog');
const { producedPaths } = await import(pathToFileURL(path.join(install, 'src/integrations/slack-session/hub/projection.mjs')));
const { HubFiles } = await import(pathToFileURL(path.join(install, 'src/integrations/slack-session/hub/files.mjs')));
const calls = stored.messages.flatMap((message) => message.toolCalls || []);
const items = stored.messages.filter((message) => message.role === 'tool').flatMap((message) => {
  const call = calls.find((entry) => entry.id === message.toolCallId);
  return call ? [{ kind: 'tool', name: call.name, args: call.arguments, result: message.content }] : [];
});
const files = await new HubFiles(project).snapshot(sessionId, producedPaths(items));
assert.ok(files.some((file) => file.path === 'design/gangbyeon-technomart-1792132797-256879.png' && file.downloadable));
const { preDispatchDenyForSession } = await import(pathToFileURL(path.join(install, 'src/runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs')));
assert.match(preDispatchDenyForSession(stored, { name: 'shell', arguments: { command: 'NO_EXECUTION_VERIFICATION_ONLY' } }), /denied/u);
console.log(JSON.stringify({ origin: origin.origin, assets: 'exact-source-match', anonymous: 401,
  memberPolicyStored: true, memberShellGate: 'denied-without-execution', image: files.map(({ path: file, downloadable }) => ({ path: file, downloadable })) }));
