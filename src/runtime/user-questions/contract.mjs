import { schemaValueError } from '../shared/schema-value-error.mjs';

export function isUserQuestionTool(name) {
  return name === 'request_user_input' || name === 'ask_user';
}

const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });

export const USER_QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          id: { ...text(64), pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' },
          header: text(40),
          question: text(4_096),
          options: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                label: text(200),
                description: { type: 'string', maxLength: 1_024 },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

export function normalizeUserQuestions(input) {
  const error = schemaValueError(input, USER_QUESTION_SCHEMA, 'request_user_input');
  if (error) throw new TypeError(error);
  const ids = new Set();
  return input.questions.map((item) => {
    if (ids.has(item.id)) throw new TypeError('question ids must be unique');
    ids.add(item.id);
    const labels = new Set();
    const options = (item.options || []).map((option) => {
      const label = option.label.trim();
      if (labels.has(label)) throw new TypeError('option labels must be unique within a question');
      labels.add(label);
      return { label, ...(option.description !== undefined ? { description: option.description.trim() } : {}) };
    });
    return {
      id: item.id,
      ...(item.header !== undefined ? { header: item.header.trim() } : {}),
      question: item.question.trim(),
      options,
    };
  });
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    cancelled: { type: 'boolean' },
    answers: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          option: { type: 'integer', minimum: 0, maximum: 5 },
          text: text(8_192),
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

// Shared by IPC, the daemon and the queue. Only the queue knows which option
// indices and question ids belong to the still-pending request.
export function normalizeUserQuestionResponse(input) {
  const error = schemaValueError(input, RESPONSE_SCHEMA, 'question response');
  if (error) throw new TypeError(error);
  if (input.cancelled === true) {
    if (input.answers !== undefined) throw new TypeError('a cancelled question cannot contain answers');
    return { cancelled: true };
  }
  if (!input.answers || Object.keys(input.answers).length < 1 || Object.keys(input.answers).length > 3) {
    throw new TypeError('question response requires answers to 1–3 questions');
  }
  const answers = Object.fromEntries(
    Object.entries(input.answers).map(([id, answer]) => {
      if (Object.hasOwn(answer, 'option') === Object.hasOwn(answer, 'text')) {
        throw new TypeError('each answer requires either an option index or custom text');
      }
      return [id, Object.hasOwn(answer, 'option') ? { option: answer.option } : { text: answer.text.trim() }];
    })
  );
  return { cancelled: false, answers };
}

export function userQuestionResult(questions, input) {
  const response = normalizeUserQuestionResponse(input);
  if (response.cancelled) return { cancelled: true, answers: {}, reason: 'cancelled by user' };
  const ids = questions.map((question) => question.id);
  if (Object.keys(response.answers).length !== ids.length || ids.some((id) => !Object.hasOwn(response.answers, id))) {
    throw new TypeError('answer every question in this request, and no others');
  }
  const answers = Object.fromEntries(
    questions.map((question) => {
      const answer = response.answers[question.id];
      if (Object.hasOwn(answer, 'text')) return [question.id, { answers: [answer.text] }];
      const option = question.options[answer.option];
      if (!option) throw new TypeError(`invalid option for question ${question.id}`);
      return [question.id, { answers: [option.label] }];
    })
  );
  return { cancelled: false, answers };
}
