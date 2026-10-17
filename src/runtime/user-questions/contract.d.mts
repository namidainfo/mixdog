export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}

export interface UserQuestionRequest {
  id: string;
  sessionId: string;
  toolCallId: string | null;
  requestedAt: number;
  questions: UserQuestion[];
}

export type UserQuestionAnswer = { option: number; text?: never } | { text: string; option?: never };
export type UserQuestionResponse =
  | { cancelled: true; answers?: never }
  | { cancelled?: false; answers: Record<string, UserQuestionAnswer> };

export interface UserQuestionResult {
  cancelled: boolean;
  answers: Record<string, { answers: string[] }>;
  reason?: string;
}

export const USER_QUESTION_SCHEMA: Record<string, unknown>;
export function isUserQuestionTool(name: unknown): boolean;
export function normalizeUserQuestions(input: unknown): UserQuestion[];
export function normalizeUserQuestionResponse(input: unknown): UserQuestionResponse;
export function userQuestionResult(questions: UserQuestion[], input: unknown): UserQuestionResult;
