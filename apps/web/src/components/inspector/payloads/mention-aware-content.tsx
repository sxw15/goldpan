'use client';

import { type ReactNode, useMemo } from 'react';
import { parseEntityMentions } from '@/lib/parse-entity-mentions';
import type { InspectorPayload } from './types';

interface MentionAwareContentProps {
  content: string;
  /** Lowercased entity name → entity id (case-insensitive lookup). */
  knownEntities: Map<string, number>;
  /** Callback to navigate to a resolved entity within the Inspector stack. */
  onNavigateEntity: (next: InspectorPayload) => void;
  /** Tooltip shown on hover for unresolved @mentions (no matching entity). */
  unresolvedTooltip?: string;
  className?: string;
}

/**
 * Renders text with `@name` tokens transformed into:
 * - clickable `<button>` (gp-mention class) when name is in knownEntities
 * - plain `<span>` (gp-mention gp-mention--unresolved) otherwise
 *
 * Uses `<button>` not `<Link>` so navigation stays inside the Inspector
 * stack (matching `linkedEntities` chip behavior at note-payload.tsx:691).
 */
export function MentionAwareContent({
  content,
  knownEntities,
  onNavigateEntity,
  unresolvedTooltip,
  className,
}: MentionAwareContentProps) {
  const mentions = useMemo(() => parseEntityMentions(content), [content]);

  if (mentions.length === 0) {
    return <span className={className}>{content}</span>;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const m of mentions) {
    if (m.start > cursor) {
      nodes.push(content.slice(cursor, m.start));
    }
    const entityId = knownEntities.get(m.name.toLowerCase());
    if (entityId !== undefined) {
      nodes.push(
        <button
          key={`mention-${m.start}`}
          type="button"
          className="gp-mention"
          onClick={() => onNavigateEntity({ kind: 'entity', id: entityId })}
        >
          @{m.name}
        </button>,
      );
    } else {
      nodes.push(
        <span
          key={`mention-${m.start}`}
          className="gp-mention gp-mention--unresolved"
          title={unresolvedTooltip}
        >
          @{m.name}
        </span>,
      );
    }
    cursor = m.end;
  }
  if (cursor < content.length) {
    nodes.push(content.slice(cursor));
  }

  return <span className={className}>{nodes}</span>;
}
