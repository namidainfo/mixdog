import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
const key = (value) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');
export function allowedAddress(address) {
  const value = String(address || '').replace(/^::ffff:/u, '');
  return value === '127.0.0.1' || value === '::1' || /^192\.168\.19\.(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/u.test(value);
}
export class HubAccess {
  constructor({ authorize, sendCode, now = Date.now }) {
    Object.assign(this, { authorize, sendCode, now });
    this.challenges = new Map(); this.sessions = new Map(); this.rates = new Map();
  }
  sweep() {
    for (const map of [this.challenges, this.sessions, this.rates]) {
      for (const [id, value] of map) if (value.expires <= this.now()) map.delete(id);
    }
  }
  rate(id) {
    const value = this.rates.get(id) || { count: 0, expires: this.now() + 60_000 };
    if (value.count >= 5 || this.rates.size >= 2000) throw Object.assign(new Error('잠시 후 다시 시도해 주세요.'), { status: 429 });
    value.count += 1; this.rates.set(id, value);
  }
  async challenge(subject, address) {
    this.sweep(); this.rate(`ip:${address}`); this.rate(`user:${subject.teamId}:${subject.userId}`);
    if (this.challenges.size >= 1000) throw Object.assign(new Error('잠시 후 다시 시도해 주세요.'), { status: 429 });
    const id = token(), code = randomBytes(9).toString('base64url');
    if (await this.authorize(subject)) {
      await this.sendCode(subject, code);
      this.challenges.set(id, { ...subject, address, code: key(code), expires: this.now() + 300_000, attempts: 0 });
    }
    return { challengeId: id, message: '승인된 계정이면 Slack 개인 메시지로 로그인 코드를 보냈습니다. 5분 안에 입력해 주세요.' };
  }
  async verify({ challengeId, code }, address) {
    this.sweep(); this.rate(`verify:${address}`);
    const pending = this.challenges.get(challengeId);
    const supplied = typeof code === 'string' ? key(code.trim()) : key('');
    if (!pending || pending.address !== address || ++pending.attempts > 5
      || !timingSafeEqual(pending.code, supplied)) {
      if (pending?.attempts >= 5) this.challenges.delete(challengeId);
      throw Object.assign(new Error('코드가 일치하지 않거나 만료되었습니다. Slack에서 새 코드를 받아 주세요.'), { status: 401 });
    }
    this.challenges.delete(challengeId);
    if (!await this.authorize(pending)) throw Object.assign(new Error('승인된 Slack 계정으로 로그인해 주세요.'), { status: 401 });
    if (this.sessions.size >= 1000) throw Object.assign(new Error('로그인 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.'), { status: 429 });
    const value = token(), session = { teamId: pending.teamId, userId: pending.userId, csrf: token(),
      address, expires: this.now() + 8 * 60 * 60_000 };
    this.sessions.set(value, session); return { token: value, session };
  }
  async current(value, address) {
    this.sweep(); const session = this.sessions.get(value);
    if (!session || session.address !== address || !await this.authorize(session)) {
      this.sessions.delete(value);
      throw Object.assign(new Error('승인된 Slack 계정으로 로그인해 주세요.'), { status: 401 });
    }
    return session;
  }
  logout(value) { this.sessions.delete(value); }
}
