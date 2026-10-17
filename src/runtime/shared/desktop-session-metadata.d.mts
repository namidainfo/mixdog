export type BloomSessionPurpose = 'chat' | 'work' | 'structured-text' | 'gateway';

export type DesktopSessionMetadata = {
  classification: 'task' | 'project';
  projectPath: string | null;
  source?: 'bloom';
  purpose?: BloomSessionPurpose;
  titleHint?: string;
};

export const BLOOM_PROJECT_ALIAS: 'Bloom';
export function bloomSessionPurpose(value: unknown): BloomSessionPurpose | null;
export function normalizeDesktopSessionMetadata(
  value: unknown,
  cwd?: string | null
): DesktopSessionMetadata | null;
export function retainBloomProjectMetadata<T>(
  current: unknown,
  next: T
): DesktopSessionMetadata | T;
