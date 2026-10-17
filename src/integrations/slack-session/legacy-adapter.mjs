import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SlackWorkerTransport } from './transport.mjs';
import { SlackMixdogRelay } from './relay.mjs';
import { SLACK_PROJECT_CWD } from './project.mjs';
import { slackSessionOwners } from './identity.mjs';

function positive(value, fallback, name) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return parsed;
}

export async function createLegacySlackAdapter(deps) {
  const { config, StateStore, client, legacyStore, resolveIdentity, loadAttachments, api, helpers } = deps;
  const env = process.env;
  for (const name of ['MIXDOG_SLACK_NODE', 'MIXDOG_SLACK_WORKER', 'MIXDOG_SLACK_RUNTIME_ROOT']) {
    if (!env[name]) throw new Error(`${name} 설정이 필요합니다.`);
  }
  const options = {
    node: env.MIXDOG_SLACK_NODE, worker: env.MIXDOG_SLACK_WORKER,
    runtimeRoot: env.MIXDOG_SLACK_RUNTIME_ROOT, cwd: SLACK_PROJECT_CWD,
    provider: env.MIXDOG_SLACK_PROVIDER || 'openai-oauth',
    model: env.MIXDOG_SLACK_MODEL || 'gpt-6.1-sol', effort: env.MIXDOG_SLACK_EFFORT || 'ultra',
    contextTokens: positive(env.MIXDOG_SLACK_CONTEXT_TOKENS, 500000, 'contextTokens'),
    maxAttachmentBytes: positive(env.MIXDOG_SLACK_MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024, 'maxAttachmentBytes'),
    maxPromptChars: config.jawMaxPromptChars, maxTurns: config.jawSessionMaxTurns,
    timeoutMs: config.jawTimeoutMs, pollIntervalMs: config.pollIntervalMs, messageIntervalMs: 1000,
    conversationLimits: {
      maxTurns: config.jawSessionMaxTurns, maxContextChars: config.jawContextMaxChars,
      recentTurns: config.jawRecentTurns, maxSummaryChars: config.jawSummaryMaxChars,
    },
  };
  const stateFile = path.resolve(env.MIXDOG_SLACK_STATE_FILE || path.join(os.homedir(), '.local/state/mixdog-slack-bridge/state.json'));
  if (stateFile === path.resolve(config.stateFile)) throw new Error('기존 Codex 기록과 Mixdog 상태 파일은 분리해야 합니다.');
  await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const store = new StateStore(stateFile);
  const log = (message) => console.error(`[mixdog-slack] ${message}`);
  const hubOptions = env.MIXDOG_HUB_ORIGIN ? { origin: env.MIXDOG_HUB_ORIGIN,
    adminUsers: (env.MIXDOG_HUB_ADMINS || '').split(',').map((value) => value.trim()).filter(Boolean),
    tlsKeyPath: env.MIXDOG_HUB_TLS_KEY, tlsCertPath: env.MIXDOG_HUB_TLS_CERT,
    documentsFile: env.MIXDOG_HUB_DOCUMENTS_FILE } : null;
  if (hubOptions?.origin.startsWith('https:') && (!hubOptions.tlsKeyPath || !hubOptions.tlsCertPath)) {
    throw new Error('MIXDOG_HUB_TLS_KEY와 MIXDOG_HUB_TLS_CERT에 Windows 인증서 경로를 설정해 주세요.');
  }
  const authentication = await client.auth.test({ token: config.slackBotToken });
  if (authentication.ok !== true || typeof authentication.team_id !== 'string') {
    throw new Error('공유실의 Slack 워크스페이스 인증을 확인하지 못했습니다.');
  }
  const hubTeamId = authentication.team_id;
  const adminUsers = (env.MIXDOG_HUB_ADMINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (adminUsers.some((identity) => {
      const [team, user] = identity.split(':');
      return team !== hubTeamId || !config.jawAllowedUserIds.has(user);
    })) throw new Error('공유실 관리자는 같은 Slack 워크스페이스의 기존 승인 사용자여야 합니다.');
  const transport = new SlackWorkerTransport({ ...options, log, hubOptions, hubRequest: async (method, input) => {
    if (method === 'executionAccess') {
      const person = input?.sessionId
        ? slackSessionOwners(store.listConversations().map(([, conversation]) => conversation))
          .find((row) => row.id === input.sessionId)
        : input?.principal;
      if (!person || person.teamId !== hubTeamId || !/^[UW][A-Z0-9]+$/u.test(person.userId || '')) {
        throw new Error('Slack 세션의 소유자를 확인하지 못했습니다.');
      }
      const active = helpers.isJawRequestAuthorized({
        team: person.teamId, user: person.userId, channel: [...config.jawAllowedChannelIds][0],
      }, config) === true;
      return { version: 1, teamId: person.teamId, userId: person.userId, active,
        admin: active && adminUsers.includes(`${person.teamId}:${person.userId}`), root: SLACK_PROJECT_CWD };
    }
    if (method === 'conversations') return store.listConversations().map(([key, conversation]) => [key, {
      teamId: conversation.teamId, actorId: conversation.actorId, userName: conversation.userName,
      channelId: conversation.channelId, threadTs: conversation.threadTs,
      nativeSessionId: conversation.nativeSessionId, nativeSessionHistory: conversation.nativeSessionHistory,
      sessionTitle: conversation.sessionTitle,
      requests: Object.fromEntries(Object.entries(conversation.requests || {}).map(([id, request]) =>
        [id, { userId: request.userId, sessionId: request.sessionId }])),
    }]);
    if (method === 'authorize') {
      if (!hubTeamId || input?.team !== hubTeamId) return false;
      return helpers.isJawRequestAuthorized({
        ...input, channel: [...config.jawAllowedChannelIds][0],
      }, config);
    }
    if (method === 'sendCode') {
      const { person, code } = input;
      const result = await client.chat.postMessage({
        token: config.slackBotToken, channel: person.userId, unfurl_links: false, unfurl_media: false,
        text: `SOFTON 세션 공유실 로그인 코드: ${code}\n5분 안에 요청한 공유실 페이지에 입력하세요. 본인이 요청하지 않았다면 사용하지 마세요.`,
      });
      if (!result.ok) throw new Error('Slack 개인 메시지 전송에 실패했습니다. 봇 DM 권한을 확인해 주세요.');
      return { sent: true };
    }
    throw new Error('허용되지 않은 공유실 브리지 요청입니다.');
  } });
  const relay = new SlackMixdogRelay({
    config: options, store, transport, api, log,
    postMessage: (payload) => client.chat.postMessage({ token: config.slackBotToken, ...payload }),
    authorize: (message) => helpers.isJawRequestAuthorized(message, config),
    resolveIdentity,
    extractPrompt: (message, botUserId, hasConversation) => {
      const key = `slack:${message.team}:${message.channel}:${message.thread_ts || message.ts}`;
      const explicit = helpers.extractJawPrompt(message, botUserId, config.jawLiteralName)
        ?? helpers.extractJawPrompt(message, botUserId, 'mixdog');
      if (explicit !== null) return explicit;
      if (String(message.text || '').trim().startsWith('!')) return message.text.trim();
      return helpers.extractPrimaryImplicitPrompt(message, config, {
        hasConversation: hasConversation || Boolean(legacyStore.getConversation(key)),
      });
    },
    loadAttachments: async (files) => {
      const size = files.reduce((sum, file) => sum + Number(file.size), 0);
      if (!Number.isFinite(size) || size > options.maxAttachmentBytes) throw new Error('첨부 파일은 합계 20MiB 이하로 보내 주세요.');
      for (const file of files) {
        const url = new URL(file.url_private_download || file.url_private);
        if (url.protocol !== 'https:' || !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))) {
          throw new Error('Slack의 인증된 첨부 URL만 사용할 수 있습니다.');
        }
      }
      return loadAttachments(files);
    },
    chunkText: (text) => helpers.chunkSlackText(text, config.maxSummaryChars),
  });
  return relay;
}
