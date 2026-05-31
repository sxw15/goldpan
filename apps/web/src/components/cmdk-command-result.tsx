'use client';

import { useTranslations } from 'next-intl';
import type { CommandDefinition } from './cmdk-commands';

interface CmdKCommandResultProps {
  command: CommandDefinition;
  selected: boolean;
  onSelect: (cmd: CommandDefinition) => void;
  onHover: (cmd: CommandDefinition) => void;
}

export function CmdKCommandResult({
  command,
  selected,
  onSelect,
  onHover,
}: CmdKCommandResultProps) {
  const t = useTranslations('cmdk');
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: WAI-ARIA listbox pattern; focus stays on input via aria-activedescendant (Phase 0 spec §5.3 / §7.1)
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation handled centrally on palette input (ArrowUp/Down/Enter) per Phase 0 spec §5.3
    <li
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox pattern requires <li role="option"> per WAI-ARIA 1.2
      role="option"
      aria-selected={selected}
      id={`cmdk-option-${command.id}`}
      className={
        selected
          ? 'gp-cmdk__row gp-cmdk__row--command gp-cmdk__row--selected'
          : 'gp-cmdk__row gp-cmdk__row--command'
      }
      onMouseEnter={() => onHover(command)}
      onClick={() => onSelect(command)}
    >
      <span className="gp-cmdk__cmd-mark" aria-hidden>
        ›
      </span>
      <span className="gp-cmdk__name">{t(command.labelKey)}</span>
      <span className="gp-cmdk__meta">{t(command.descKey)}</span>
    </li>
  );
}
