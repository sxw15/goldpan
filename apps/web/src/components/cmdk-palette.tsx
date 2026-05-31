'use client';

import type { Entity } from '@goldpan/web-sdk';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment, useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { logoutAction } from '@/actions/auth';
import { useTheme } from '@/components/theme-provider';
import { getBrowserApiClient } from '@/lib/api-client-browser';
import { rethrowNextErrors } from '@/lib/rethrow';
import { nextTheme } from '@/lib/theme-cycle';
import { CmdKCommandResult } from './cmdk-command-result';
import { COMMANDS, type CommandContext, type CommandDefinition } from './cmdk-commands';
import { CmdKEntityResult } from './cmdk-entity-result';
import { useCmdK } from './cmdk-provider';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; entities: Entity[] }
  | { status: 'error'; message: string };

function scoreEntity(entity: Entity, q: string): number {
  const name = entity.name.toLowerCase();
  if (name.startsWith(q)) return 10;
  if (name.includes(q)) return 5;
  if (entity.categoryPaths.some((p) => p.toLowerCase().includes(q))) return 2;
  return 0;
}

export function CmdKPalette() {
  const { open, setOpen } = useCmdK();
  const t = useTranslations('cmdk');
  const pathname = usePathname() ?? '';
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { theme, setTheme } = useTheme();
  const [, startLogoutTransition] = useTransition();

  // theme changes → palette re-renders (useTheme is a context hook), so cycleTheme
  // closure always captures the latest `theme`. setTheme signature is
  // `(theme: Theme) => void` (NOT a functional setter) — see theme-provider.tsx.
  const cycleTheme = useCallback(() => setTheme(nextTheme(theme)), [theme, setTheme]);
  // Without try/catch, a fetch failure before logoutAction reaches the server
  // would surface as an unhandled rejection (useTransition swallows the throw)
  // and the user would see the palette close with no feedback while the cookie
  // survives. NEXT_REDIRECT (digest-tagged) is the success path — re-raise it.
  const startLogout = useCallback(() => {
    startLogoutTransition(async () => {
      try {
        await logoutAction();
      } catch (err) {
        rethrowNextErrors(err);
        console.error('[cmdk] logout failed', err);
      }
    });
  }, []);

  const ctx = useMemo<CommandContext>(
    () => ({ router, pathname, cycleTheme, startLogout }),
    [router, pathname, cycleTheme, startLogout],
  );

  // 焦点还原由 provider 管（需要在 setOpen(true) 之前抓 activeElement）。
  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelectedIndex(0);
      setLoad({ status: 'idle' });
      return;
    }

    setLoad({ status: 'loading' });
    let cancelled = false;
    getBrowserApiClient()
      .getEntities()
      .then((res) => {
        if (cancelled) return;
        setLoad({ status: 'ready', entities: res.data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoad({ status: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const mode: 'entity' | 'command' = query.startsWith('>') ? 'command' : 'entity';
  const commandQuery = mode === 'command' ? query.slice(1).trim().toLowerCase() : '';

  // Drop a stale entity-fetch error when the user enters command mode: the
  // error pertains to entity browsing context the user has just left, and
  // would otherwise surface only after backspacing back, decoupled from the
  // action that caused it.
  useEffect(() => {
    if (mode !== 'command') return;
    setLoad((prev) => (prev.status === 'error' ? { status: 'idle' } : prev));
  }, [mode]);

  const entityResults = useMemo((): Entity[] => {
    if (mode !== 'entity') return [];
    if (load.status !== 'ready') return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = load.entities
      .map((e) => ({ entity: e, score: scoreEntity(e, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.entity.name.localeCompare(b.entity.name);
      })
      .slice(0, 20)
      .map((x) => x.entity);
    return scored;
  }, [mode, load, query]);

  const commandResults = useMemo((): readonly CommandDefinition[] => {
    if (mode !== 'command') return [];
    if (commandQuery === '') return COMMANDS;
    return COMMANDS.filter((c) => t(c.labelKey).toLowerCase().includes(commandQuery));
  }, [mode, commandQuery, t]);

  const activeResultsLength = mode === 'command' ? commandResults.length : entityResults.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: effect purpose is to reset selection on every query change; [query] is the trigger, not a read dep
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  const close = () => setOpen(false);
  const navigateToEntity = (id: number) => {
    const href = `/library?focus=${id}`;
    // Preserve the opener page for the first cross-page jump, while keeping
    // repeated focus changes inside `/library` collapsed to one entry.
    if (pathname === '/library') {
      router.replace(href);
    } else {
      router.push(href);
    }
    close();
  };

  const executeCommand = (cmd: CommandDefinition) => {
    // `finally close()`: a command throwing must not strand the palette open.
    // `Error.digest` marks framework-internal throws (NEXT_REDIRECT etc.) —
    // re-raise so Next can handle them; only swallow user-facing failures.
    try {
      cmd.execute(ctx);
    } catch (err) {
      rethrowNextErrors(err);
      console.error('[cmdk] command failed', cmd.id, err);
    } finally {
      close();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (activeResultsLength === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % activeResultsLength);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + activeResultsLength) % activeResultsLength);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'command') {
        const selected = commandResults[selectedIndex];
        if (selected) executeCommand(selected);
      } else {
        const selected = entityResults[selectedIndex];
        if (selected) navigateToEntity(selected.id);
      }
    }
  };

  const activeId =
    mode === 'command'
      ? commandResults[selectedIndex]
        ? `cmdk-option-${commandResults[selectedIndex].id}`
        : undefined
      : entityResults[selectedIndex]
        ? `cmdk-option-${entityResults[selectedIndex].id}`
        : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a presentation element; click/Escape-to-close is supplementary to global Escape handler in provider (Phase 0 spec §5.3 / §8.3)
    <div
      className="gp-cmdk__backdrop"
      role="presentation"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div
        className="gp-cmdk__panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('label')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          placeholder={t('placeholder')}
          // biome-ignore lint/a11y/noAutofocus: command palette semantics require focusing search input on open (Phase 0 spec §5.3 / §7.1)
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-controls="cmdk-listbox"
          aria-activedescendant={activeId}
        />
        {mode === 'entity' && load.status === 'loading' && <p>{t('loading')}</p>}
        {mode === 'entity' && load.status === 'error' && (
          <p role="alert">{t('error', { message: load.message })}</p>
        )}
        {mode === 'entity' &&
          load.status === 'ready' &&
          query.trim() !== '' &&
          entityResults.length === 0 && <p>{t('empty')}</p>}
        {mode === 'entity' && load.status === 'ready' && entityResults.length > 0 && (
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox pattern requires <ul role="listbox"> per WAI-ARIA 1.2
          <ul id="cmdk-listbox" role="listbox">
            {entityResults.map((entity, i) => (
              <CmdKEntityResult
                key={entity.id}
                entity={entity}
                selected={i === selectedIndex}
                onSelect={(e) => navigateToEntity(e.id)}
                onHover={() => setSelectedIndex(i)}
              />
            ))}
          </ul>
        )}
        {mode === 'command' && commandResults.length === 0 && <p>{t('command_empty')}</p>}
        {mode === 'command' && commandResults.length > 0 && (
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox pattern requires <ul role="listbox"> per WAI-ARIA 1.2
          <ul id="cmdk-listbox" role="listbox">
            {(['navigation', 'action'] as const).map((group) => {
              const items = commandResults.filter((c) => c.group === group);
              if (items.length === 0) return null;
              return (
                <Fragment key={group}>
                  <li role="presentation" className="gp-cmdk__group-label">
                    {t(group === 'navigation' ? 'group_navigation' : 'group_action')}
                  </li>
                  {items.map((cmd) => (
                    <CmdKCommandResult
                      key={cmd.id}
                      command={cmd}
                      selected={cmd.id === commandResults[selectedIndex]?.id}
                      onSelect={executeCommand}
                      onHover={() =>
                        setSelectedIndex(commandResults.findIndex((c) => c.id === cmd.id))
                      }
                    />
                  ))}
                </Fragment>
              );
            })}
          </ul>
        )}
        <footer className="gp-cmdk__hint">
          {t(mode === 'entity' ? 'shortcut_hint' : 'command_shortcut_hint')}
        </footer>
      </div>
    </div>
  );
}
