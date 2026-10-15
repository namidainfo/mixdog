import { normalizeUserQuestions, USER_QUESTION_SCHEMA } from './contract.mjs';

export const REQUEST_USER_INPUT_TOOL = {
  name: 'request_user_input',
  title: 'Ask User',
  annotations: {
    title: 'Ask User',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    agentHidden: true,
  },
  description:
    'Ask the user 1–3 questions and wait for their answers before continuing. Each question has a unique id, optional short header, question text, and up to 6 labeled options with optional descriptions. The user can select one option or enter custom text; omit options for a text-only question. Returns answers keyed by question id, or explicit cancellation. This is not tool approval and does not authorize actions. Never infer or automatically select an answer.',
  inputSchema: USER_QUESTION_SCHEMA,
};

export async function executeUserQuestion(args, callerCtx = {}) {
  const questions = normalizeUserQuestions(args);
  if (typeof callerCtx.userQuestionHook !== 'function') {
    throw new Error('request_user_input requires an interactive user-question surface');
  }
  return callerCtx.userQuestionHook({
    questions,
    sessionId: callerCtx.callerSessionId,
    toolCallId: callerCtx.toolCallId || null,
    signal: callerCtx.signal,
  });
}
