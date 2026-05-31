'use client';

import { Plus, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type RefObject, useRef } from 'react';

interface ChatInputProps {
  action: (payload: FormData) => void;
  isPending: boolean;
  maxInputLength: number;
  value: string;
  onChange: (value: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

type IntentKind = 'submit' | 'query' | 'note';
type IntentInput = 'url' | 'text' | 'paste';
type IntentGuess = { kind: IntentKind; input?: IntentInput };

const URL_LIKE = /^https?:\/\/|youtu\.be|youtube\.com|x\.com|twitter\.com|github\.com|arxiv\.org/i;
const QUESTION = /[?？]|什么|如何|怎么|为什么|是否|多少|哪些|对比|比较|why|how|what/i;
const OPINION = /我觉得|我认为|个人(觉得|认为)|看法|观点|i think|i believe/i;

function classifyIntent(text: string): IntentGuess | null {
  const t = text.trim();
  if (!t) return null;
  if (URL_LIKE.test(t)) return { kind: 'submit', input: 'url' };
  if (t.length > 220) return { kind: 'submit', input: 'paste' };
  if (QUESTION.test(t)) return { kind: 'query' };
  if (OPINION.test(t)) return { kind: 'note' };
  return { kind: 'submit', input: 'text' };
}

export function ChatInput({
  action,
  isPending,
  maxInputLength,
  value,
  onChange,
  textareaRef,
}: ChatInputProps) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const formRef = useRef<HTMLFormElement>(null);
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    internalRef.current = el;
    if (textareaRef) textareaRef.current = el;
  };

  // Auto-resize the textarea up to the CSS max-height. Run inline on each
  // change instead of via useEffect — the resize is a direct DOM consequence
  // of the change event, not a separate effect, so coupling it to a deps
  // array introduces synchronisation noise the linter rightly flags.
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  };

  const intent = classifyIntent(value);
  const intentLabel = intent
    ? t(
        `intent_label_${intent.kind}` as
          | 'intent_label_submit'
          | 'intent_label_query'
          | 'intent_label_note',
      )
    : null;
  const intentInputLabel =
    intent?.input != null
      ? t(
          `intent_input_${intent.input}` as
            | 'intent_input_url'
            | 'intent_input_text'
            | 'intent_input_paste',
        )
      : null;

  const isEmpty = !value.trim();

  return (
    <form
      ref={formRef}
      action={(formData) => {
        action(formData);
        onChange('');
        formRef.current?.reset();
      }}
      className="gp-chat__form"
    >
      <div className="gp-chat__composer">
        <textarea
          ref={setRef}
          name="input"
          className="gp-chat__textarea"
          placeholder={t('input_placeholder')}
          aria-label={t('input_placeholder')}
          required
          disabled={isPending}
          autoComplete="off"
          rows={1}
          maxLength={maxInputLength}
          value={value}
          onChange={handleChange}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="gp-chat__composer-bar">
          <button
            type="button"
            className="gp-chat__attach"
            aria-label={t('composer_attach_label')}
            tabIndex={-1}
            disabled
          >
            <Plus size={15} aria-hidden />
          </button>
          <span className="gp-chat__hint">
            {intent ? (
              <span className="gp-chat__intent">
                {t('intent_label_prefix')} <strong>{intentLabel}</strong>
                {intentInputLabel ? ` · ${intentInputLabel}` : ''}
              </span>
            ) : (
              <>
                <kbd>{t('keyboard_hint_enter')}</kbd>
                {t('keyboard_hint_send')} · <kbd>{t('keyboard_hint_shift_enter')}</kbd>
                {t('keyboard_hint_newline')}
              </>
            )}
          </span>
          <button
            type="submit"
            className="gp-chat__send-btn"
            disabled={isPending || isEmpty}
            aria-label={isPending ? common('submitting') : t('composer_send_label')}
          >
            <Send size={14} aria-hidden />
          </button>
        </div>
      </div>
    </form>
  );
}
