// One ownership index for both the web reader and the execution-policy issuer.
// Ambiguous or mixed-owner sessions fail closed, including rotated histories.
export function slackSessionOwners(conversations) {
  const rows = new Map();
  for (const conversation of conversations) {
    const requests = Object.values(conversation.requests || {});
    const ids = new Set([conversation.nativeSessionId, ...(conversation.nativeSessionHistory || []),
      ...requests.map((request) => request.sessionId)].filter(Boolean));
    for (const id of ids) {
      if (requests.some((request) => request.sessionId === id && request.userId !== conversation.actorId)) {
        rows.set(id, null); continue;
      }
      const previous = rows.get(id);
      if (previous && (previous.teamId !== conversation.teamId || previous.userId !== conversation.actorId)) {
        rows.set(id, null); continue;
      }
      if (previous === null) continue;
      rows.set(id, { id, teamId: conversation.teamId, userId: conversation.actorId,
        userName: conversation.userName, title: conversation.sessionTitle || '제목 확인 필요',
        channelId: conversation.channelId, threadTs: conversation.threadTs, current: id === conversation.nativeSessionId });
    }
  }
  return [...rows.values()].filter(Boolean);
}
