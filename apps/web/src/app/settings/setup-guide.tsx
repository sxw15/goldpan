'use client';

import type { PluginSetupGuideDescriptor } from '@goldpan/web-sdk';
import Image from 'next/image';
import { useTranslations } from 'next-intl';

interface SetupGuideProps {
  pluginId: string;
  guide: PluginSetupGuideDescriptor;
}

function assetUrl(pluginId: string, path: string): string {
  // Encode each segment separately so `/` is preserved as a path separator.
  // The server (contributions.ts) splits the asset path on `/` and joins the
  // remainder unchanged; encoding the whole `path` would turn `steps/01.png`
  // into `steps%2F01.png`, and the server would then look for a literal file
  // named `steps%2F01.png` instead of `steps/01.png`.
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `/api/settings/contributions/${encodeURIComponent(pluginId)}/assets/${encodedPath}`;
}

export function SetupGuide({ pluginId, guide }: SetupGuideProps) {
  const t = useTranslations('plugin_card');
  return (
    <details className="gp-plugin-setup-guide">
      <summary className="gp-plugin-setup-guide__summary">{t('setup_guide')}</summary>
      <ol className="gp-plugin-setup-guide__steps">
        {guide.steps.map((step) => (
          <li key={step.id} className="gp-plugin-setup-guide__step">
            <h4 className="gp-plugin-setup-guide__step-title">{step.title}</h4>
            <p className="gp-plugin-setup-guide__step-desc">{step.desc}</p>
            {step.images !== undefined && step.images.length > 0 && (
              <div className="gp-plugin-setup-guide__images">
                {step.images.map((img) => (
                  // `unoptimized` because the asset comes from the plugin's
                  // own /api/settings/contributions/:pluginId/assets/ route,
                  // not the Next image-optimizer-friendly /_next/image
                  // pipeline. Width/height are required-ish defaults — actual
                  // sizing is handled by .gp-plugin-setup-guide__image CSS.
                  <Image
                    key={img}
                    src={assetUrl(pluginId, img)}
                    alt={step.title}
                    className="gp-plugin-setup-guide__image"
                    width={400}
                    height={240}
                    unoptimized
                  />
                ))}
              </div>
            )}
            {step.externalLink !== undefined && (
              <a
                className="gp-plugin-setup-guide__link"
                href={step.externalLink.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {step.externalLink.label}
              </a>
            )}
            {step.code !== undefined && (
              <pre className={`gp-plugin-setup-guide__code language-${step.code.language}`}>
                <code>{step.code.text}</code>
              </pre>
            )}
          </li>
        ))}
      </ol>
      {guide.allDoneTitle !== undefined && (
        <p className="gp-plugin-setup-guide__done">{guide.allDoneTitle}</p>
      )}
    </details>
  );
}
