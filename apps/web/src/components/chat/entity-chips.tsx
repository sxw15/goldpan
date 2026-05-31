'use client';

import type { CitedEntity } from '@goldpan/web-sdk';

interface EntityChipsProps {
  label: string;
  entities: CitedEntity[];
  onSelect: (entity: CitedEntity) => void;
}

export function EntityChips({ label, entities, onSelect }: EntityChipsProps) {
  if (entities.length === 0) return null;
  return (
    <div className="gp-entity-chips">
      <div className="gp-entity-chips__label">{label}</div>
      <div className="gp-entity-chips__list">
        {entities.map((e) => (
          <button
            type="button"
            key={e.id}
            className="gp-chip"
            data-variant="entity"
            title={e.categoryPaths.join(' / ')}
            onClick={() => onSelect(e)}
          >
            {e.name}
          </button>
        ))}
      </div>
    </div>
  );
}
