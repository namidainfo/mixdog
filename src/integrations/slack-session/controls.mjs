export const SLACK_HELP = [
  '*Mixdog 명령*',
  '`!new` — 이전 요약만 이관하여 새 세션',
  '`!restart` 또는 `!new clear` — 맥락을 넘기지 않는 새 세션',
  '`!stop` — 이 스레드의 주실행·대기 입력 중단',
  '`!status` — 모델·컨텍스트·턴 수·대기 상태',
  '`!approve <승인ID>` — 관리자만 도구 승인 / `!deny <승인ID>` — 본인 요청 거절',
  '`!answer <질문ID> <답변 또는 선택 번호>` — 질문에 응답',
  '`!retry` — 전송 실패·확인 불가 메시지 재전송. 이미 전달됐다면 중복될 수 있습니다.',
  '`!help` — 이 안내',
  '분리된 백그라운드 작업은 주실행 중단 후에도 남을 수 있습니다.',
  '중단·새 세션 전환은 이미 변경한 파일을 원복하지 않습니다.',
].join('\n');

export function parseSlackControl(text, parseNewSessionCommand) {
  const value = String(text || '').trim();
  const fresh = parseNewSessionCommand(value);
  if (fresh) return { type: 'new', clear: fresh.clear };
  if (/^!stop$/i.test(value)) return { type: 'stop' };
  if (/^!status$/i.test(value)) return { type: 'status' };
  if (/^!help$/i.test(value)) return { type: 'help' };
  if (/^!retry$/i.test(value)) return { type: 'retry' };
  const approval = value.match(/^!(approve|deny)\s+(\S+)$/i);
  if (approval) return { type: 'approve', id: approval[2], approved: approval[1].toLowerCase() === 'approve' };
  const answer = value.match(/^!answer\s+(\S+)\s+([\s\S]+)$/i);
  if (answer) return { type: 'answer', id: answer[1], text: answer[2] };
  return value.startsWith('!') ? { type: 'invalid' } : null;
}

export function rotationReason(conversation, context, maxTurns) {
  if (conversation.turnCount >= maxTurns) return 'turn-limit';
  const limits = [context.contextWindow, context.effectiveContextWindow, context.compaction?.triggerTokens]
    .map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (limits.length && Number(context.usedTokens) + Number(context.nextPromptTokens) >= Math.min(...limits)) {
    return 'context-budget';
  }
  return '';
}

export function questionResponse(request, value) {
  const text = String(value || '').trim();
  if (text === '--cancel') return { cancelled: true };
  if (text.startsWith('{')) return JSON.parse(text);
  if (request.questions.length !== 1) {
    throw new Error('여러 질문에는 JSON으로 답하세요: {"answers":{"질문ID":{"text":"답변"}}}');
  }
  const question = request.questions[0];
  let answer = { text };
  if (/^\d+$/.test(text) && question.options?.length) {
    const index = Number(text) - 1;
    if (index < 0 || index >= question.options.length) throw new Error('보기 번호가 올바르지 않습니다.');
    answer = { option: index };
  }
  return { cancelled: false, answers: { [question.id]: answer } };
}

export function questionText(request) {
  const lines = [`🟠 *입력이 필요합니다* · 질문 ID: \`${request.id}\``];
  for (const question of request.questions) {
    lines.push(`*${question.header || question.id}* — ${question.question}`);
    for (const [index, option] of (question.options || []).entries()) {
      lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`);
    }
  }
  lines.push(`\`!answer ${request.id} 답변\`으로 응답하세요.`);
  if (request.questions.length === 1) lines.push('이 스레드에 답변만 입력해도 같은 질문에 전달됩니다.');
  else lines.push('여러 질문은 {"answers":{"질문ID":{"text":"답변"}}} 형식으로 전달하세요.');
  return lines.join('\n');
}

export function approvalText(request) {
  const args = JSON.stringify(request.args, null, 2) || '';
  return [
    `🟠 *도구 승인이 필요합니다* · \`${request.name}\``,
    request.reason,
    request.cwd ? `작업 폴더: \`${request.cwd}\`` : '',
    `\`\`\`\n${args.slice(0, 6000).replaceAll('```', '`\u200b``')}\n\`\`\``,
    args.length > 6000 ? '인자가 길어 일부를 생략했습니다. 승인 전 믹스독에서 원문을 확인하세요.' : '',
    '일반 Slack 사용자의 요청은 PC 소유자가 Mixdog 승인 화면에서 확인해야 합니다.',
    `Slack 관리자 승인: \`!approve ${request.id}\``,
    `거절: \`!deny ${request.id}\``,
  ].filter(Boolean).join('\n');
}

export function statusText(conversation, state, context, limits) {
  const uncertain = conversation.outbox.filter((item) => ['failed', 'uncertain', 'posting'].includes(item.status)).length;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '미확인';
  return [
    '*Mixdog 실행 정보*',
    `모델: ${state?.model || limits.model} · ${String(state?.effort || limits.effort).toUpperCase()}`,
    `설정 한도: ${number(limits.contextTokens)} tokens`,
    context ? `컨텍스트: ${number(context.usedTokens)} / ${number(context.contextWindow)} tokens · ${context.usedSource}` : '컨텍스트: 아직 측정되지 않음',
    `턴: ${conversation.turnCount}/${limits.maxTurns} · 대기: ${conversation.queue.length}`,
    `상태: ${conversation.needsStop ? '중단 확인 필요' : state?.userQuestion ? '질문 대기' : state?.toolApproval ? '승인 대기' : conversation.activeRequestId ? '실행·전달 중' : '유휴'}`,
    `세션: \`${conversation.logicalSessionId}\` · 세대 ${conversation.generation}`,
    conversation.nativeSessionId ? `Mixdog: \`${conversation.nativeSessionId}\`` : 'Mixdog 세션: 첫 요청 시 생성',
    `작업 폴더: \`${limits.cwd}\``,
    uncertain ? `⚠️ 전송 실패·확인 불가 ${uncertain}건. \`!retry\`는 중복 전송 가능성을 감수하고 다시 보냅니다.` : '',
  ].filter(Boolean).join('\n');
}
