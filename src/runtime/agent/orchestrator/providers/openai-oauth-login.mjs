/**
 * OpenAI ChatGPT OAuth PKCE login flow.
 *
 * PKCE generation, authorization-code
 * exchange, the localhost callback server, and interactive login helpers.
 * openai-oauth.mjs re-exports beginOAuthLogin/loginOAuth as a facade so
 * existing importers resolve unchanged. Token persistence + JWT parsing stay
 * owned by openai-oauth-tokens.mjs and are injected here to avoid a circular
 * import of its module-level token store state.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createOAuthPkce, parseOAuthCodeInput } from './lib/oauth-pkce.mjs';
import { OAUTH_PAGE_CONTENT_TYPE, oauthSuccessHtml, oauthErrorHtml } from './lib/oauth-page.mjs';
import { classifyTransportError, transportErrorText } from '../../../shared/transport-error-text.mjs';
import { withOAuthTlsDiagnostics } from './openai-oauth-tls-diagnostics.mjs';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;

function _scrubOAuthLoginBody(text) {
  return String(text || '')
    .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[REDACTED]"')
    .replace(/"id_token"\s*:\s*"[^"]+"/g, '"id_token":"[REDACTED]"')
    .replace(/[A-Za-z0-9_-]{32,}\.[A-Za-z0-9._-]+/g, '[REDACTED]');
}

/**
 * @param {object} deps
 * @param {string} deps.clientId
 * @param {string} deps.originator
 * @param {(token:string)=>(string|undefined)} deps.extractAccountId
 * @param {(token:string)=>number} deps.expiryFromAccessToken
 * @param {(tokens:object)=>void} deps.saveTokens
 */
export function createOpenAIOAuthLogin(deps) {
  const { clientId, originator, extractAccountId, expiryFromAccessToken, saveTokens, createServerFn = createServer } = deps;

  async function exchangeAuthorizationCode({ pkce, code, signal }) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new Error('[openai-oauth] authorization code is required');
    let tokenRes;
    try {
      tokenRes = await withOAuthTlsDiagnostics(() => fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: cleanCode,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: pkce.verifier,
      }),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]),
      }));
    } catch (cause) {
      const code = classifyTransportError(cause)?.code;
      const detail = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
        ? transportErrorText({ code })
        : null;
      throw new Error(`[openai-oauth] 인증 코드 교환 실패: ${detail || '연결 요청에 실패했습니다.'}`, { cause });
    }
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      throw new Error(`[openai-oauth] token exchange ${tokenRes.status}: ${_scrubOAuthLoginBody(text).slice(0, 500)}`);
    }
    const json = await tokenRes.json();
    if (!json.access_token || !json.refresh_token) {
      throw new Error('[openai-oauth] token exchange response missing access_token or refresh_token');
    }
    const expiresAt =
      (typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0) ||
      expiryFromAccessToken(json.access_token);
    const tokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: expiresAt,
      account_id: extractAccountId(json.access_token),
    };
    signal.throwIfAborted();
    saveTokens(tokens);
    return tokens;
  }

  async function beginOAuthLogin() {
    const pkce = createOAuthPkce(64);
    const state = randomBytes(16).toString('hex');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('originator', originator);

    let server = null;
    let timeout = null;
    let finish = null;
    const controller = new AbortController();
    let exchangePromise = null;
    const waitForCallback = new Promise((resolve, reject) => {
      let settled = false;
      finish = (value, error = null) => {
        if (settled) return;
        settled = true;
        controller.abort();
        if (timeout) clearTimeout(timeout);
        try {
          server?.close();
        } catch {
          /* already closed */
        }
        if (error) reject(error);
        else resolve(value);
      };
      server = createServerFn(async (req, res) => {
        const u = new URL(req.url || '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
        if (u.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = u.searchParams.get('code');
        if (!code || u.searchParams.get('state') !== state) {
          res.writeHead(400);
          res.end('Invalid');
          finish(null);
          return;
        }
        if (settled) {
          res.writeHead(409);
          res.end('Login is already processing or closed');
          return;
        }
        try {
          exchangePromise ??= exchangeAuthorizationCode({ pkce, code, signal: controller.signal });
          const tokens = await exchangePromise;
          res.writeHead(200, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE });
          res.end(oauthSuccessHtml('OpenAI'));
          finish(tokens);
        } catch (err) {
          res.writeHead(502, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE });
          res.end(oauthErrorHtml('앱에서 인증을 완료하지 못했습니다. 앱의 오류 내용을 확인하고 다시 시도해 주세요.'));
          finish(null, err instanceof Error ? err : new Error(String(err)));
        }
      });
      timeout = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
      server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
        process.stderr.write(
          `\n[openai-oauth] Open this URL to log in to ChatGPT (OpenAI OAuth):\n${url.toString()}\n\n`
        );
        try {
          const { openInBrowser } = await import('../../../shared/open-url.mjs');
          openInBrowser(url.toString());
        } catch (err) {
          process.stderr.write(`[openai-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
        }
      });
      server.on('error', (err) =>
        finish(
          null,
          new Error(
            `[openai-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`
          )
        )
      );
    });

    return {
      provider: 'openai-oauth',
      url: url.toString(),
      waitForCallback,
      completeCode: async (input) => {
        controller.signal.throwIfAborted();
        const parsed = parseOAuthCodeInput(input, { allowHashState: true });
        if (parsed.state && parsed.state !== state) throw new Error('[openai-oauth] OAuth state mismatch');
        let tokens;
        try {
          exchangePromise ??= exchangeAuthorizationCode({ pkce, code: parsed.code, signal: controller.signal });
          tokens = await exchangePromise;
        } catch (error) {
          finish?.(null, error);
          throw error;
        }
        finish?.(tokens);
        return tokens;
      },
      cancel: () => {
        finish?.(null);
      },
    };
  }

  async function loginOAuth() {
    const login = await beginOAuthLogin();
    return await login.waitForCallback;
  }

  return { beginOAuthLogin, loginOAuth };
}
