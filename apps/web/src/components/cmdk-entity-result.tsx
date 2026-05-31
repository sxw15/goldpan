'use client';

import type { Entity } from '@goldpan/web-sdk';

interface CmdKEntityResultProps {
  entity: Entity;
  selected: boolean;
  onSelect: (entity: Entity) => void;
  onHover: (entity: Entity) => void;
}

export function CmdKEntityResult({ entity, selected, onSelect, onHover }: CmdKEntityResultProps) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: WAI-ARIA listbox pattern; focus stays on input via aria-activedescendant (Phase 0 spec §5.3 / §7.1)
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation handled centrally on palette input (ArrowUp/Down/Enter) per Phase 0 spec §5.3
    <li
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox pattern requires <li role="option"> per WAI-ARIA 1.2
      role="option"
      aria-selected={selected}
      id={`cmdk-option-${entity.id}`}
      className={selected ? 'gp-cmdk__row gp-cmdk__row--selected' : 'gp-cmdk__row'}
      onMouseEnter={() => onHover(entity)}
      onClick={() => onSelect(entity)}
    >
      <span className="gp-cmdk__name">{entity.name}</span>
      <span className="gp-cmdk__meta">
        {entity.categoryPaths.join(' · ')} · {entity.activePointCount} 点
      </span>
    </li>
  );
}
