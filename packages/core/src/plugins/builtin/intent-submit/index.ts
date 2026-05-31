import { submitInput, submitText } from '../../../submit';
import type { IntentPlugin } from '../../types';

export const intentSubmitPlugin: IntentPlugin = {
  name: 'intent-submit',
  version: '1.0.0',
  type: 'intent',
  description: 'Built-in plugin for content submission (URL, text, thoughts)',

  intents: [
    {
      name: 'submit_url',
      description:
        'The input contains a URL that the user wants to submit for processing (may include brief annotation)',
      descriptions: {
        zh: '输入包含用户希望提交处理的 URL 链接（可能附带简短注释）',
      },
      examples: ['https://example.com/article', 'Check out this article: https://...'],
      classificationHints: [
        'If the input contains a URL and the surrounding text is brief context/annotation, choose `submit_url`',
      ],
      priority: 0,
      resultTypes: ['submit'],
    },
    {
      name: 'submit_text',
      description:
        'The input is factual text content, notes, or knowledge the user wants to record',
      descriptions: {
        zh: '输入是用户希望记录的事实性文本内容、笔记或知识',
      },
      examples: ['TypeScript 5.0 introduced decorators as a stable feature...'],
      classificationHints: [
        'If the input is factual content or notes the user wants to store, choose `submit_text`',
        'When ambiguous between `submit_text` and `record_thought`, prefer `submit_text` for neutral content',
      ],
      priority: 0,
      resultTypes: ['submit'],
    },
    {
      name: 'record_thought',
      description:
        'The input is a subjective opinion, reflection, or personal thought the user wants to save',
      descriptions: {
        zh: '输入是用户希望保存的主观看法、感想或个人想法',
      },
      examples: ['I think the new React compiler approach is interesting because...'],
      classificationHints: [
        'If the input expresses personal opinions, feelings, or reflections, choose `record_thought`',
      ],
      priority: 0,
      resultTypes: ['submit'],
    },
  ],

  async execute(intent, input, ctx, _signal) {
    // record_thought uses submitText (not submitInput) to bypass URL detection —
    // opinion text should be stored as-is even if it happens to contain a URL.
    if (intent === 'record_thought') {
      const result = await submitText(input, {
        db: ctx.db,
        submissionLog: ctx.repos.submissionLog,
        maxTextInputLength: ctx.config.maxTextInputLength,
        ssrfValidationEnabled: ctx.config.ssrfValidationEnabled,
        inputMode: 'opinion',
      });
      return { type: 'submit', result };
    }

    const result = await submitInput(input, {
      db: ctx.db,
      submissionLog: ctx.repos.submissionLog,
      maxTextInputLength: ctx.config.maxTextInputLength,
      ssrfValidationEnabled: ctx.config.ssrfValidationEnabled,
    });
    return { type: 'submit', result };
  },
};
