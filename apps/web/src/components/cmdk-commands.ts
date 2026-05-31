import type { useRouter } from 'next/navigation';

export type CommandGroup = 'navigation' | 'action';

export type CommandId =
  | 'open_chat'
  | 'open_library'
  | 'open_tracking'
  | 'open_digest'
  | 'open_conversations'
  | 'open_settings'
  | 'toggle_theme'
  | 'logout'
  | 'new_interest';

export interface CommandContext {
  router: ReturnType<typeof useRouter>;
  pathname: string;
  cycleTheme: () => void;
  startLogout: () => void;
}

// Distributive form locks `id` to its own `labelKey`/`descKey` per element:
// `{ id: 'open_chat', labelKey: 'commands.open_library.label' }` would not
// satisfy this type, even though both fields are individually valid CommandIds.
export type CommandDefinition = {
  [K in CommandId]: {
    id: K;
    group: CommandGroup;
    labelKey: `commands.${K}.label`;
    descKey: `commands.${K}.desc`;
    execute: (ctx: CommandContext) => void;
  };
}[CommandId];

// labelKey / descKey are relative to the `cmdk` i18n namespace (consumers scope
// `useTranslations('cmdk')`).
export const COMMANDS = [
  {
    id: 'open_chat',
    group: 'navigation',
    labelKey: 'commands.open_chat.label',
    descKey: 'commands.open_chat.desc',
    execute: ({ router }) => router.push('/'),
  },
  {
    id: 'open_library',
    group: 'navigation',
    labelKey: 'commands.open_library.label',
    descKey: 'commands.open_library.desc',
    execute: ({ router }) => router.push('/library'),
  },
  {
    id: 'open_tracking',
    group: 'navigation',
    labelKey: 'commands.open_tracking.label',
    descKey: 'commands.open_tracking.desc',
    execute: ({ router }) => router.push('/tracking'),
  },
  {
    id: 'open_digest',
    group: 'navigation',
    labelKey: 'commands.open_digest.label',
    descKey: 'commands.open_digest.desc',
    execute: ({ router }) => router.push('/digest'),
  },
  {
    id: 'open_conversations',
    group: 'navigation',
    labelKey: 'commands.open_conversations.label',
    descKey: 'commands.open_conversations.desc',
    execute: ({ router }) => router.push('/conversations'),
  },
  {
    id: 'open_settings',
    group: 'navigation',
    labelKey: 'commands.open_settings.label',
    descKey: 'commands.open_settings.desc',
    execute: ({ router }) => router.push('/settings'),
  },
  {
    id: 'toggle_theme',
    group: 'action',
    labelKey: 'commands.toggle_theme.label',
    descKey: 'commands.toggle_theme.desc',
    execute: ({ cycleTheme }) => cycleTheme(),
  },
  {
    id: 'logout',
    group: 'action',
    labelKey: 'commands.logout.label',
    descKey: 'commands.logout.desc',
    execute: ({ startLogout }) => startLogout(),
  },
  {
    id: 'new_interest',
    group: 'action',
    labelKey: 'commands.new_interest.label',
    descKey: 'commands.new_interest.desc',
    execute: ({ router, pathname }) => {
      // The new-interest form and the Inspector dialog cannot coexist visually
      // (Inspector is `role="dialog" aria-modal="true"`, would trap focus over
      // the form). Drop any `focus`/`kind` query — opening the form must
      // close any open Inspector. `replace` inside /tracking avoids minting a
      // history entry the mount-effect would immediately replace again.
      const url = '/tracking?new=1';
      if (pathname === '/tracking') {
        router.replace(url);
      } else {
        router.push(url);
      }
    },
  },
] as const satisfies readonly CommandDefinition[];
