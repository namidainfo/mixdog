import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIOAuthLogin } from './openai-oauth-login.mjs';

async function harness(t, fetchFn, save = () => {}) {
  t.mock.method(globalThis, 'fetch', fetchFn);
  let callback;
  const login = await createOpenAIOAuthLogin({
    clientId: 'test-client',
    originator: 'test',
    extractAccountId: () => 'test-account',
    identityFromTokens: (idToken, accessToken) => {
      assert.equal(idToken, 'test-id');
      assert.equal(accessToken, 'test-access');
      return { email: 'test@example.com' };
    },
    expiryFromAccessToken: () => 123,
    saveTokens: save,
    createServerFn(handler) {
      callback = handler;
      return { listen() {}, on() {}, close() {} };
    },
  }).beginOAuthLogin();
  const result = login.waitForCallback.then(value => ({ value }), error => ({ error }));
  t.after(() => login.cancel());
  const state = new URL(login.url).searchParams.get('state');
  async function request(stateValue = state) {
    const response = { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await callback({ url: `/auth/callback?code=test-code&state=${stateValue}` }, response);
    return response;
  }
  return { login, result, request };
}

const tokens = () => Response.json({ access_token: 'test-access', id_token: 'test-id', refresh_token: 'test-refresh', expires_in: 3600 });

test('callback only reports success after exchange and persistence', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let saved = false;
  const h = await harness(t, () => pending, () => { saved = true; });
  const response = h.request();
  assert.equal(saved, false);
  release(tokens());
  const page = await response;
  assert.equal(saved, true);
  assert.equal(page.status, 200);
  assert.match(page.body, /Authentication successful/);
  assert.equal((await h.result).value.account_id, 'test-account');
  assert.deepEqual((await h.result).value.identity, { email: 'test@example.com' });
});

test('wrapped TLS failure preserves safe cause code and never shows success', async t => {
  const cause = Object.assign(new Error('private diagnostic'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  const failure = new TypeError('fetch failed', { cause });
  let calls = 0;
  const h = await harness(t, async () => { calls++; throw failure; }, () => assert.fail('must not save'));
  const page = await h.request();
  const { error } = await h.result;
  assert.equal(page.status, 502);
  assert.match(page.body, /Authentication failed/);
  assert.doesNotMatch(page.body, /Authentication successful|private diagnostic/);
  assert.match(error.message, /인증 코드 교환 실패.*SELF_SIGNED_CERT_IN_CHAIN/);
  assert.doesNotMatch(error.message, /private diagnostic/);
  assert.equal(error.cause, failure);
  assert.equal(calls, 1);
});

test('persistence failure produces failure page', async t => {
  const h = await harness(t, async () => tokens(), () => { throw new Error('save failed'); });
  assert.equal((await h.request()).status, 502);
  assert.match((await h.result).error.message, /save failed/);
});

test('cancellation during exchange prevents credential persistence and success', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = await harness(t, () => pending, () => assert.fail('must not save'));
  const response = h.request();
  h.login.cancel();
  release(tokens());
  assert.equal((await response).status, 502);
  assert.equal((await h.result).value, null);
});

test('invalid state never exchanges credentials', async t => {
  const h = await harness(t, () => assert.fail('must not fetch'));
  assert.equal((await h.request('wrong')).status, 400);
  assert.equal((await h.result).value, null);
});

test('duplicate callback does not exchange a code twice', async t => {
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const h = await harness(t, () => { calls++; return pending; });
  const first = h.request();
  const second = h.request();
  release(tokens());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(calls, 1);
});

test('manual completion joins browser exchange without contradictory failure', async t => {
  let release;
  let calls = 0;
  let saves = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const h = await harness(t, () => { calls++; return pending; }, () => { saves++; });
  const page = h.request();
  const manual = h.login.completeCode('test-code');
  release(tokens());
  assert.equal((await page).status, 200);
  assert.equal((await manual).account_id, 'test-account');
  assert.equal((await h.result).value.account_id, 'test-account');
  assert.equal(calls, 1);
  assert.equal(saves, 1);
});

test('untrusted diagnostic payload is not copied into displayed cause code', async t => {
  const cause = Object.assign(new Error('private'), { code: `CERT_${'payload '.repeat(500)}` });
  const h = await harness(t, async () => { throw cause; });
  assert.equal((await h.request()).status, 502);
  const { error } = await h.result;
  assert.ok(error.message.length < 200);
  assert.doesNotMatch(error.message, /payload|private/);
  assert.equal(error.cause, cause);
});
