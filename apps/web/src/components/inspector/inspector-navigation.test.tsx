import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../confirm-provider';

vi.mock('./payloads', () => ({
  PayloadRouter: ({
    payload,
    onNavigateEntity,
  }: {
    payload: { kind: 'entity' | 'source'; id: number };
    onNavigateEntity: (next: { kind: 'entity'; id: number }) => void;
  }) =>
    payload.kind === 'source' ? (
      <button type="button" onClick={() => onNavigateEntity({ kind: 'entity', id: 7 })}>
        Open entity
      </button>
    ) : (
      <button type="button">Entity body</button>
    ),
}));

import { Inspector } from './inspector';

// Inspector now consumes useConfirm centrally (PR #57) for the dirty-edit
// close guard, so a ConfirmProvider ancestor is required. The common namespace
// supplies the default modal labels in case the guard fires.
const messages = {
  inspector: {
    back_fallback: '返回',
    close: '关闭',
    kind_entity: '实体',
    kind_source: '来源',
    unsaved_confirm: '放弃未保存的修改？',
  },
  common: {
    ok: '确定',
    cancel: '取消',
    confirm_default_title: '确认',
  },
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="zh" messages={messages}>
      <ConfirmProvider>{ui}</ConfirmProvider>
    </NextIntlClientProvider>
  );
}

describe('<Inspector> navigation', () => {
  it('updates kind badge when navigating from source to entity inside the inspector', async () => {
    const tInspector = (key: 'kind_entity' | 'kind_source') => messages.inspector[key];

    render(
      wrap(
        <Inspector
          payload={{ kind: 'source', id: 42 }}
          onClose={vi.fn()}
          backFallbackLabel={messages.inspector.back_fallback}
          closeLabel={messages.inspector.close}
          getKindLabel={(kind) => tInspector(kind === 'source' ? 'kind_source' : 'kind_entity')}
        />,
      ),
    );

    expect(screen.getByText('来源')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open entity' }));
    expect(await screen.findByText('实体')).toBeInTheDocument();
  });

  it('moves focus back into the dialog after internal navigation', async () => {
    render(
      wrap(
        <Inspector
          payload={{ kind: 'source', id: 42 }}
          onClose={vi.fn()}
          backFallbackLabel={messages.inspector.back_fallback}
          closeLabel={messages.inspector.close}
          getKindLabel={(kind) =>
            messages.inspector[`kind_${kind}` as 'kind_entity' | 'kind_source']
          }
        />,
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open entity' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /42/ })).toHaveFocus();
    });
  });
});
