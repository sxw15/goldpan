'use client';

import { Library, ListTodo, MessageCircle, Newspaper, Radar } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface MobileTabbarProps {
  chatLabel: string;
  libraryLabel: string;
  trackingLabel: string;
  digestLabel: string;
  tasksLabel: string;
  navLabel: string;
}

function isActive(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/';
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function MobileTabbar({
  chatLabel,
  libraryLabel,
  trackingLabel,
  digestLabel,
  tasksLabel,
  navLabel,
}: MobileTabbarProps) {
  const pathname = usePathname() ?? '';

  const tabs = [
    { href: '/', label: chatLabel, Icon: MessageCircle },
    { href: '/library', label: libraryLabel, Icon: Library },
    { href: '/tracking', label: trackingLabel, Icon: Radar },
    { href: '/digest', label: digestLabel, Icon: Newspaper },
    { href: '/tasks', label: tasksLabel, Icon: ListTodo },
  ] as const;

  return (
    <nav className="gp-mobile-tabbar" aria-label={navLabel}>
      {tabs.map(({ href, label, Icon }) => (
        <Link
          key={href}
          href={href}
          className="gp-mobile-tabbar__tab"
          aria-current={isActive(pathname, href) ? 'page' : undefined}
        >
          <Icon size={20} aria-hidden />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
