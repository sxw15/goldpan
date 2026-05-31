'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useTheme } from '@/components/theme-provider';
import { nextTheme } from '@/lib/theme-cycle';

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();
  const t = useTranslations('common');

  // useEffect only runs on the client, so now we can safely show the UI
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Avoid layout shift by rendering a placeholder of the same size
    return <div style={{ width: '32px', height: '32px' }} />;
  }

  return (
    <button
      type="button"
      className="gp-btn gp-theme-toggle"
      data-variant="ghost"
      onClick={() => setTheme(nextTheme(theme))}
      title={t('theme_label', { theme })}
      aria-label={t('toggle_theme')}
    >
      {theme === 'system' && <Monitor size={18} strokeWidth={1.75} />}
      {theme === 'light' && <Sun size={18} strokeWidth={1.75} />}
      {theme === 'dark' && <Moon size={18} strokeWidth={1.75} />}
    </button>
  );
}
