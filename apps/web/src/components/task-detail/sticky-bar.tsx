'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { TASK_STATUS_CHIP } from '@/lib/task-display';

export type StickyStatus = 'done' | 'error' | 'processing';

interface StickyBarProps {
  status: StickyStatus;
  taskId: number;
  backHref: string;
  backLabel: string;
  taskCrumbLabel: string;
  statusLabel: string;
  primaryMetric?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
}

export function StickyBar({
  status,
  taskId,
  backHref,
  backLabel,
  taskCrumbLabel,
  statusLabel,
  primaryMetric,
  primaryAction,
  secondaryActions,
}: StickyBarProps) {
  return (
    <div className="gp-td-sticky">
      <Link href={backHref} className="gp-td-sticky__back">
        ← {backLabel}
      </Link>
      <div className="gp-td-sticky__crumb">
        <span>{taskCrumbLabel}</span>
        <b>#{taskId}</b>
      </div>
      <div className="gp-td-sticky__main">
        <span className={`gp-status ${TASK_STATUS_CHIP[status]}`}>{statusLabel}</span>
        {primaryMetric ? <span className="gp-td-sticky__metric">{primaryMetric}</span> : null}
      </div>
      <div className="gp-td-sticky__spacer" />
      <div className="gp-td-sticky__actions">
        {secondaryActions}
        {primaryAction}
      </div>
    </div>
  );
}
