/** This lane opens an existing daemon session; cwd is context, never a
 * request to create a session or change the session's project. */
export interface DesktopSessionOpenRequest {
  sessionId: string;
  cwd: string | null;
}

export interface DesktopSessionOpenDelivery extends DesktopSessionOpenRequest {
  requestId: string;
  expiresAt: number;
  cancelled?: boolean;
}

export interface DesktopSessionOpenResult {
  requestId: string;
  sessionId: string;
  opened: boolean;
  error?: string;
}

export function isSessionOpenRequest(value: unknown): value is DesktopSessionOpenRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<DesktopSessionOpenRequest>;
  return (
    typeof request.sessionId === 'string' &&
    request.sessionId.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(request.sessionId) &&
    (request.cwd === null || typeof request.cwd === 'string')
  );
}

export function isSessionOpenDelivery(value: unknown): value is DesktopSessionOpenDelivery {
  return (
    isSessionOpenRequest(value) &&
    typeof (value as DesktopSessionOpenDelivery).requestId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test((value as DesktopSessionOpenDelivery).requestId) &&
    Number.isSafeInteger((value as DesktopSessionOpenDelivery).expiresAt) &&
    (value as DesktopSessionOpenDelivery).expiresAt > 0 &&
    ((value as DesktopSessionOpenDelivery).cancelled === undefined || typeof (value as DesktopSessionOpenDelivery).cancelled === 'boolean')
  );
}
