'use client';

import type { ImSettingsManifest, LocalizedString } from '@goldpan/web-sdk';
import Image from 'next/image';
import { type ReactNode, useState } from 'react';
import { Lightbox } from './lightbox';

const t = (s: LocalizedString, lang: 'en' | 'zh') => s[lang];
const tr = (lang: 'en' | 'zh', zh: string, en: string) => (lang === 'zh' ? zh : en);

// URLs embedded in step desc render as inline links so users can right-click
// → copy, or click to open. Trailing punctuation (.,;:) is excluded from the
// match so "...点击此处。" doesn't capture the trailing period as part of the URL.
const URL_REGEX = /(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?，。；：！？])/g;

function renderDescWithLinks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const url = match[0];
    const start = match.index;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <a
        key={`u${key++}`}
        className="gp-setup-step__desc-link"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {url}
      </a>,
    );
    cursor = start + url.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function SetupGuide({
  manifest,
  language,
}: {
  manifest: ImSettingsManifest;
  language: 'en' | 'zh';
}) {
  const steps = manifest.setupGuide.steps;
  const baseUrl = `/api/settings/im/${manifest.channelId}/assets/`;

  // Default: guide is collapsed. Only the prompt row shows. Old users who
  // already know how to configure can fill the fields directly without the
  // 6-step tutorial blocking them. New users still see a clear entry point.
  const [currentStep, setCurrentStep] = useState(steps.length);
  const [completed, setCompleted] = useState<Set<number>>(() => new Set());
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const isCollapsed = currentStep >= steps.length;
  const hasProgress = completed.size > 0;

  function markCurrentDone() {
    setCompleted((prev) => {
      const next = new Set(prev);
      next.add(currentStep);
      return next;
    });
    setCurrentStep((s) => s + 1);
  }
  const dismiss = () => setCurrentStep(steps.length);
  const reopen = () => setCurrentStep(0);

  const headerTitle =
    language === 'zh'
      ? `首次接入指南 · ${t(manifest.branding.name, language)}`
      : `Setup guide · ${t(manifest.branding.name, language)}`;
  const toggleLabel = isCollapsed
    ? tr(language, '展开接入指南', 'Expand setup guide')
    : tr(language, '收起接入指南', 'Collapse setup guide');

  return (
    <div className={`gp-setup-guide${isCollapsed ? ' gp-setup-guide--collapsed' : ''}`}>
      <button
        type="button"
        className="gp-setup-guide__bar"
        onClick={isCollapsed ? reopen : dismiss}
        aria-expanded={!isCollapsed}
        aria-label={toggleLabel}
      >
        <span
          className={`gp-setup-guide__bar-chevron${
            isCollapsed ? '' : ' gp-setup-guide__bar-chevron--open'
          }`}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </span>
        <span className="gp-setup-guide__bar-title">{headerTitle}</span>
        {!isCollapsed && (
          <span className="gp-setup-guide__bar-progress" aria-live="polite">
            {language === 'zh'
              ? `第 ${Math.min(currentStep + 1, steps.length)} 步 / 共 ${steps.length} 步`
              : `Step ${Math.min(currentStep + 1, steps.length)} of ${steps.length}`}
          </span>
        )}
        {isCollapsed && hasProgress && (
          <span
            className="gp-setup-guide__bar-done-badge"
            role="img"
            title={t(manifest.setupGuide.allDoneTitle, language)}
            aria-label={t(manifest.setupGuide.allDoneTitle, language)}
          >
            ✓
          </span>
        )}
      </button>

      {!isCollapsed && (
        <ol className="gp-setup-guide__steps">
          {steps.map((step, idx) => {
            const isDone = completed.has(idx);
            const isCurrent = idx === currentStep;
            const stateCls = isCurrent
              ? 'gp-setup-step--current'
              : isDone
                ? 'gp-setup-step--done'
                : 'gp-setup-step--pending';
            return (
              <li
                key={step.id}
                className={`gp-setup-step ${stateCls}`}
                aria-current={isCurrent ? 'step' : undefined}
              >
                <button
                  type="button"
                  className="gp-setup-step__head"
                  onClick={() => setCurrentStep(idx)}
                  aria-expanded={isCurrent}
                >
                  <span
                    className={`gp-setup-step__num gp-setup-step__num--${
                      isCurrent ? 'current' : isDone ? 'done' : 'pending'
                    }`}
                    aria-hidden="true"
                  >
                    {!isCurrent && isDone ? '✓' : idx + 1}
                  </span>
                  <span className="gp-setup-step__head-title">{t(step.title, language)}</span>
                </button>
                {isCurrent && (
                  <div className="gp-setup-step__body">
                    <p className="gp-setup-step__desc">
                      {renderDescWithLinks(t(step.desc, language))}
                    </p>
                    {step.externalLink && (
                      <a
                        className="gp-setup-step__external"
                        href={step.externalLink.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t(step.externalLink.label, language)} ↗
                      </a>
                    )}
                    {step.code && <CodeBlock code={step.code} language={language} />}
                    {step.images.length > 0 && (
                      <div className="gp-setup-step__thumbs">
                        {step.images.map((img, i) => {
                          const src = `${baseUrl}${img}`;
                          const alt = t(step.title, language);
                          return (
                            <button
                              key={img}
                              type="button"
                              className="gp-setup-step__thumb"
                              onClick={() => setLightbox({ src, alt })}
                              aria-label={`${alt} (${i + 1}/${step.images.length})`}
                            >
                              <Image
                                src={src}
                                alt={alt}
                                width={240}
                                height={150}
                                className="gp-setup-step__thumb-img"
                                unoptimized
                              />
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="gp-setup-step__actions">
                      <button
                        type="button"
                        className="gp-setup-step__next"
                        onClick={markCurrentDone}
                      >
                        {idx === steps.length - 1
                          ? language === 'zh'
                            ? '完成'
                            : 'Finish'
                          : language === 'zh'
                            ? '下一步'
                            : 'Next'}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {lightbox && (
        <Lightbox
          src={lightbox.src}
          alt={lightbox.alt}
          closeLabel={language === 'zh' ? '关闭' : 'Close'}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function CodeBlock({
  code,
  language,
}: {
  code: { language: string; text: string };
  language: 'en' | 'zh';
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="gp-setup-step__code">
      <div className="gp-setup-step__code-bar">
        <span className="gp-setup-step__code-label">{code.language}</span>
        <button
          type="button"
          className="gp-setup-step__code-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {}
          }}
        >
          {copied ? (language === 'zh' ? '已复制' : 'Copied') : language === 'zh' ? '复制' : 'Copy'}
        </button>
      </div>
      <pre className="gp-setup-step__code-pre">{code.text}</pre>
    </div>
  );
}
