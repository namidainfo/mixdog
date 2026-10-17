import { bloomSessionPurpose } from './desktop-session-metadata.mjs';
import { sessionTitleDatePrefix, splitSessionTitleDatePrefix } from './session-title-format.mjs';

export function bloomSessionTitle(session, value) {
  const purpose = bloomSessionPurpose(session?.desktopSession);
  if (!purpose) return value;
  const label = purpose === 'structured-text' ? '[Bloom·자동]' : purpose === 'gateway' ? '[Bloom·조회]' : '[Bloom]';
  const { prefix, title } = splitSessionTitleDatePrefix(value);
  const body = title.startsWith(`${label} `) ? title.slice(label.length + 1) : title;
  return `${session.generatedTitlePrefix || prefix || sessionTitleDatePrefix(session.createdAt)}${label} ${body}`;
}

export function hasPendingBloomTitle(session) {
  return !!bloomSessionPurpose(session?.desktopSession) && session.bloomTitlePending === true;
}

export function initializeBloomSessionTitle(session) {
  const purpose = bloomSessionPurpose(session?.desktopSession);
  if (!purpose || purpose === 'gateway' || session.title || session.titleLocked === true) return false;
  const body = purpose === 'structured-text' ? session.desktopSession.titleHint || '자동 처리' : '새 대화';
  session.title = bloomSessionTitle(session, body);
  if (purpose === 'chat' || purpose === 'work') session.bloomTitlePending = true;
  session.titleUpdatedAt = session.createdAt;
  return true;
}
