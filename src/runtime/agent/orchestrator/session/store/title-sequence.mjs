import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginData } from '../../config.mjs';
import { isHiddenAgent } from '../../internal-agents.mjs';
import { isOrdinarySession } from '../store-summary-visibility.mjs';
import { withFileLockSync, writeJsonAtomicSync } from '../../../../shared/atomic-file.mjs';
import {
  sessionTitleDateKey,
  sessionTitleDatePrefix,
  splitSessionTitleDatePrefix,
} from '../../../../shared/session-title-format.mjs';

// Independent of the session catalog: deleting a session must not free its
// number. The lock covers both the read and durable increment across processes.
export function reserveSessionTitle(session) {
  if (!isOrdinarySession(session) || isHiddenAgent(session.agent)) return null;
  const createdAt = session.createdAt;
  const day = sessionTitleDateKey(createdAt);
  const path = join(getPluginData(), 'session-title-sequences.json');
  return withFileLockSync(`${path}.lock`, () => {
    let counters;
    try {
      counters = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      counters = {};
    }
    if (!counters || typeof counters !== 'object' || Array.isArray(counters)) {
      throw new Error(`Invalid session title sequence store: ${path}`);
    }
    const sequence = Object.hasOwn(counters, day) ? counters[day] : 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence === Number.MAX_SAFE_INTEGER) {
      throw new Error(`Invalid session title sequence for ${day}: ${path}`);
    }
    counters[day] = sequence + 1;
    writeJsonAtomicSync(path, counters, { lock: false });
    return { createdAt, prefix: sessionTitleDatePrefix(createdAt, sequence) };
  });
}

// Called only when the ask queue admits a real user prompt, under its session
// lock. Empty reservations and service-control reads never reach this boundary.
export function assignSessionTitlePrefix(session, numberedAt = Date.now()) {
  if (session.closed === true || session.generatedTitlePrefix) return false;
  const reservation = reserveSessionTitle({ ...session, createdAt: numberedAt });
  if (!reservation) return false;
  session.generatedTitlePrefix = reservation.prefix;
  if (session.title && (session.titleLocked !== true || session.titlePrefixPending === true)) {
    session.title = `${reservation.prefix}${splitSessionTitleDatePrefix(session.title).title}`;
  }
  delete session.titlePrefixPending;
  return true;
}
