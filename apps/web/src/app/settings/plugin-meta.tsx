'use client';

import type { ReactNode } from 'react';

interface PluginMetaProps {
  name: string;
  version: string;
  description?: string;
  homepage?: string;
  /**
   * Right-aligned slot in the header row — used by group renderers to
   * inline the plugin's enable toggle next to the branding so a disabled
   * plugin collapses to a single visual row.
   */
  trailing?: ReactNode;
}

export function PluginMeta({ name, version, description, homepage, trailing }: PluginMetaProps) {
  return (
    <header className="gp-plugin-meta">
      <div className="gp-plugin-meta__left">
        <div className="gp-plugin-meta__primary">
          <h3 className="gp-plugin-meta__name">{name}</h3>
          <span className="gp-plugin-meta__version">v{version}</span>
        </div>
        {description !== undefined && description.length > 0 && (
          <p className="gp-plugin-meta__description">{description}</p>
        )}
        {homepage !== undefined && homepage.length > 0 && (
          <a
            className="gp-plugin-meta__homepage"
            href={homepage}
            target="_blank"
            rel="noreferrer noopener"
          >
            {homepage}
          </a>
        )}
      </div>
      {trailing !== undefined && <div className="gp-plugin-meta__trailing">{trailing}</div>}
    </header>
  );
}
