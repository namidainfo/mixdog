export const BLOOM_PROJECT_ALIAS = 'Bloom';

const BLOOM_PURPOSES = new Set(['chat', 'work', 'structured-text', 'gateway']);

export function bloomSessionPurpose(value) {
  return value?.source === 'bloom' && BLOOM_PURPOSES.has(value.purpose) ? value.purpose : null;
}

export function normalizeDesktopSessionMetadata(value, cwd = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cleanPath = (path) => {
    if (typeof path !== 'string') return null;
    const trimmed = path.trim();
    return trimmed && !trimmed.includes('\0') ? trimmed : null;
  };
  let normalized;
  if (value.classification === 'task') {
    normalized = { classification: 'task', projectPath: null };
  } else if (value.classification === 'project') {
    const projectPath = cleanPath(value.projectPath) || cleanPath(cwd);
    if (!projectPath) return null;
    normalized = { classification: 'project', projectPath };
  } else {
    return null;
  }
  const purpose = bloomSessionPurpose(value);
  if (purpose) {
    normalized.source = 'bloom';
    normalized.purpose = purpose;
    if (purpose === 'structured-text' && typeof value.titleHint === 'string' && value.titleHint.trim()) {
      normalized.titleHint = value.titleHint.trim().slice(0, 100);
    }
  }
  return normalized;
}

// An integration's catalog home is not its execution workspace.
export function retainBloomProjectMetadata(current, next) {
  return bloomSessionPurpose(current) ? normalizeDesktopSessionMetadata(current) : next;
}
