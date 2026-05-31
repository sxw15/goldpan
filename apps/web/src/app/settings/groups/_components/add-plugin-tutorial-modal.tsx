'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { copyToClipboard } from '@/lib/clipboard';

interface Props {
  onClose: () => void;
}

// Templates intentionally kept inline as exported strings rather than
// imported from /docs/example-plugins/llm-noop — the sample file is shaped
// for runtime, while this is shaped for copy-paste pedagogy. Keeping it
// embedded means the tutorial doesn't break when the sample's internal
// layout shifts.
const PACKAGE_JSON_TEMPLATE = `{
  "name": "@yourorg/plugin-llm-mycompany",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@ai-sdk/provider": "^3.0.8",
    "@goldpan/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
`;

const INDEX_TS_TEMPLATE = `// plugins/llm-mycompany/src/index.ts
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { LlmProviderPlugin } from '@goldpan/core/plugins';

function makeModel(modelId: string): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'mycompany',
    modelId,
    supportedUrls: {},
    async doGenerate(_options) {
      // Call your provider's API here
      return {
        content: [{ type: 'text', text: 'response' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
        request: {},
        response: { id: 'x', modelId, timestamp: new Date() },
      };
    },
    async doStream(_options) {
      throw new Error('streaming not implemented');
    },
  };
}

export const goldpanPlugin: LlmProviderPlugin = {
  name: 'llm-mycompany',
  version: '0.1.0',
  type: 'llm-provider',
  description: 'My company LLM provider',
  providerId: 'mycompany',
  createProvider() {
    return { languageModel: makeModel };
  },
};
`;

export function AddPluginTutorialModal({ onClose }: Props) {
  const t = useTranslations('settings.llm');

  return (
    <Modal
      heading={t('add_plugin_modal_heading')}
      desc={t('add_plugin_modal_desc')}
      onClose={onClose}
      closeLabel={t('add_btn_close')}
    >
      <div className="gp-tutorial">
        <section className="gp-tutorial__step">
          <h4 className="gp-tutorial__heading">{t('add_plugin_step1_heading')}</h4>
          <p className="gp-tutorial__body">{t('add_plugin_step1_body')}</p>
        </section>
        <section className="gp-tutorial__step">
          <h4 className="gp-tutorial__heading">{t('add_plugin_step2_heading')}</h4>
          <p className="gp-tutorial__body">
            {t('add_plugin_step2_body', { providerSlug: '<your-provider>' })}
          </p>
          <CodeBlock
            content={PACKAGE_JSON_TEMPLATE}
            language="json"
            copyLabel={t('add_btn_copy')}
            copiedLabel={t('add_btn_copied')}
          />
        </section>
        <section className="gp-tutorial__step">
          <h4 className="gp-tutorial__heading">{t('add_plugin_step3_heading')}</h4>
          <p className="gp-tutorial__body">{t('add_plugin_step3_body')}</p>
          <CodeBlock
            content={INDEX_TS_TEMPLATE}
            language="typescript"
            copyLabel={t('add_btn_copy')}
            copiedLabel={t('add_btn_copied')}
          />
        </section>
        <section className="gp-tutorial__step">
          <h4 className="gp-tutorial__heading">{t('add_plugin_step4_heading')}</h4>
          <p className="gp-tutorial__body">{t('add_plugin_step4_body')}</p>
          <p className="gp-tutorial__reference">
            <code>docs/example-plugins/llm-noop/src/index.ts</code> —{' '}
            {t('add_plugin_reference_link')}
          </p>
        </section>
        <div className="gp-tutorial__footer">
          <button type="button" className="gp-btn" data-variant="secondary" onClick={onClose}>
            {t('add_btn_close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface CodeBlockProps {
  content: string;
  language: string;
  copyLabel: string;
  copiedLabel: string;
}

function CodeBlock({ content, language, copyLabel, copiedLabel }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    const ok = await copyToClipboard(content);
    if (ok) {
      setCopied(true);
      // Short feedback window — copy buttons across the app use ~1.5s
      setTimeout(() => setCopied(false), 1500);
    }
    // Silent failure on insecure contexts: the user already has the
    // text rendered on screen and can copy manually.
  }

  return (
    <div className="gp-tutorial__code">
      <div className="gp-tutorial__code-bar">
        <span className="gp-tutorial__code-lang">{language}</span>
        <button
          type="button"
          className="gp-btn"
          data-size="sm"
          data-variant="secondary"
          onClick={onCopy}
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre className="gp-tutorial__code-pre">
        <code>{content}</code>
      </pre>
    </div>
  );
}
