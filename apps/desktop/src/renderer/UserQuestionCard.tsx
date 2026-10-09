import { MessageCircleQuestion } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { UserQuestionAnswer, UserQuestionRequest, UserQuestionResponse } from '../../../../src/runtime/user-questions/contract.mjs';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';

export function UserQuestionCard({
  request,
  resolve,
}: {
  request: UserQuestionRequest;
  resolve: (response: UserQuestionResponse) => Promise<boolean>;
}) {
  const titleId = useId();
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(false);
  const resolvingRef = useRef(false);
  const [answers, setAnswers] = useState<Record<string, UserQuestionAnswer>>({});
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const complete = request.questions.every((question) => {
    const answer = answers[question.id];
    return answer && (typeof answer.option === 'number' || Boolean(answer.text?.trim()));
  });

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    form.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    return () => {
      mounted.current = false;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  async function decide(response: UserQuestionResponse) {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setResolving(true);
    setError('');
    try {
      if (await resolve(response)) return;
      if (mounted.current) setError(t('Mixdog could not record this decision. Please try again.'));
    } catch (reason) {
      if (mounted.current) {
        const detail = reason instanceof Error ? reason.message : String(reason || '');
        setError(
          detail
            ? t('Mixdog could not record this decision: {{detail}}', { detail })
            : t('Mixdog could not record this decision. Please try again.')
        );
      }
    }
    if (mounted.current) {
      resolvingRef.current = false;
      setResolving(false);
    }
  }

  return (
    <form
      ref={form}
      className="approval-card user-question-card"
      aria-labelledby={titleId}
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) void decide({ answers });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        void decide({ cancelled: true });
      }}
    >
      <div className="approval-heading">
        <span><MessageCircleQuestion size={16} /></span>
        <div><b id={titleId}>{t('Answer')}</b></div>
      </div>
      <div className="approval-body user-question-body">
        {request.questions.map((question) => {
          const answer = answers[question.id];
          const custom = question.options.length === 0 || typeof answer?.text === 'string';
          const groupName = `${titleId}:${question.id}`;
          return (
            <fieldset key={question.id} disabled={resolving}>
              <legend>
                {question.header && <strong>{question.header}</strong>}
                <span>{question.question}</span>
              </legend>
              {question.options.map((option, index) => (
                <label className="user-question-option" key={option.label}>
                  <input
                    type="radio"
                    name={groupName}
                    checked={answer?.option === index}
                    onChange={() => setAnswers((current) => ({ ...current, [question.id]: { option: index } }))}
                  />
                  <span>
                    <b>{option.label}</b>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              {question.options.length > 0 && (
                <label className="user-question-option">
                  <input
                    type="radio"
                    name={groupName}
                    checked={custom}
                    onChange={() => setAnswers((current) => ({ ...current, [question.id]: { text: '' } }))}
                  />
                  <span>{t('Other')}</span>
                </label>
              )}
              {custom && (
                <textarea
                  aria-label={`${question.question} — ${t('Answer')}`}
                  rows={2}
                  maxLength={8_192}
                  value={answer?.text || ''}
                  onChange={(event) => {
                    const text = event.target.value;
                    setAnswers((current) => ({ ...current, [question.id]: { text } }));
                  }}
                />
              )}
            </fieldset>
          );
        })}
        {error && <ErrorNotice error={error} />}
      </div>
      <div className="approval-actions">
        <button type="button" className="deny" disabled={resolving} onClick={() => void decide({ cancelled: true })}>
          {t('Cancel')}
        </button>
        <button type="submit" disabled={resolving || !complete}>{t('Continue')}</button>
      </div>
    </form>
  );
}
