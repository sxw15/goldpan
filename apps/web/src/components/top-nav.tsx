'use client';

import { History, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutAction } from '@/actions/auth';
import { useCmdK } from './cmdk-provider';
import { ThemeToggle } from './theme-toggle';

interface TopNavProps {
  appTitle: string;
  chatLabel: string;
  libraryLabel: string;
  trackingLabel: string;
  digestLabel: string;
  /** Localized "Off" / "未启用" label rendered next to the Digest tab when the
   *  plugin is disabled. `null` hides the badge. */
  digestDisabledBadge: string | null;
  cmdkButtonLabel: string;
  settingsLabel: string;
  logoutLabel: string;
  tasksLabel: string;
  conversationsLabel: string;
  showLogout: boolean;
}

function isActive(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/';
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function TopNav({
  appTitle,
  chatLabel,
  libraryLabel,
  trackingLabel,
  digestLabel,
  digestDisabledBadge,
  cmdkButtonLabel,
  settingsLabel,
  logoutLabel,
  tasksLabel,
  conversationsLabel,
  showLogout,
}: TopNavProps) {
  const pathname = usePathname() ?? '';
  const cmdk = useCmdK();

  const tabs: { href: string; label: string; badge: string | null }[] = [
    { href: '/', label: chatLabel, badge: null },
    { href: '/library', label: libraryLabel, badge: null },
    { href: '/tracking', label: trackingLabel, badge: null },
    { href: '/digest', label: digestLabel, badge: digestDisabledBadge },
    { href: '/tasks', label: tasksLabel, badge: null },
  ];

  return (
    <nav className="gp-topnav">
      <div className="gp-topnav__left">
        <Link href="/" className="gp-topnav__brand">
          {appTitle}
        </Link>
      </div>
      <div className="gp-topnav__tabs">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive(pathname, tab.href) ? 'page' : undefined}
          >
            {tab.label}
            {tab.badge && (
              <span className="gp-topnav__tab-badge gp-topnav__tab-badge--warn">{tab.badge}</span>
            )}
          </Link>
        ))}
      </div>
      <div className="gp-topnav__right">
        <button
          type="button"
          className="gp-topnav__cmdk"
          onClick={(e) => cmdk.setOpen(true, e.currentTarget)}
          aria-label={cmdkButtonLabel}
          aria-keyshortcuts="Meta+K Control+K"
        >
          {cmdkButtonLabel}
        </button>
        <ThemeToggle />
        <Link
          href="/conversations"
          className="gp-btn gp-topnav__history"
          data-variant="ghost"
          aria-current={isActive(pathname, '/conversations') ? 'page' : undefined}
          aria-label={conversationsLabel}
          title={conversationsLabel}
        >
          <History size={20} strokeWidth={1.75} aria-hidden />
        </Link>
        <Link
          href="/settings"
          className="gp-btn gp-topnav__settings"
          data-variant="ghost"
          aria-current={isActive(pathname, '/settings') ? 'page' : undefined}
          aria-label={settingsLabel}
          title={settingsLabel}
        >
          <Settings size={20} strokeWidth={1.75} aria-hidden />
        </Link>
        {showLogout && (
          <form action={logoutAction}>
            <button type="submit" className="gp-btn" data-variant="ghost">
              {logoutLabel}
            </button>
          </form>
        )}
      </div>
    </nav>
  );
}
