import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SettingsSaveBar } from './settings-save-bar';

const baseProps = {
  saveLabel: '保存',
  savingLabel: '保存中…',
  undoLabel: '撤销修改',
};

describe('SettingsSaveBar', () => {
  test('hidden when visible=false (placeholder still occupies space)', () => {
    const { container } = render(
      <SettingsSaveBar
        {...baseProps}
        visible={false}
        saving={false}
        onSave={() => {}}
        onUndo={() => {}}
      />,
    );
    const root = container.querySelector('.gp-settings__save-bar');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-visible')).toBe('false');
    // Buttons not interactable / not present in the visible bar
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
  });

  test('visible renders save + undo, fires callbacks', () => {
    const onSave = vi.fn();
    const onUndo = vi.fn();
    render(
      <SettingsSaveBar {...baseProps} visible saving={false} onSave={onSave} onUndo={onUndo} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '撤销修改' }));
    expect(onUndo).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  test('disables both buttons while saving and shows savingLabel', () => {
    const onSave = vi.fn();
    const onUndo = vi.fn();
    render(<SettingsSaveBar {...baseProps} visible saving onSave={onSave} onUndo={onUndo} />);
    const save = screen.getByRole('button', { name: '保存中…' });
    const undo = screen.getByRole('button', { name: '撤销修改' });
    expect(save).toBeDisabled();
    expect(undo).toBeDisabled();
    fireEvent.click(save);
    fireEvent.click(undo);
    expect(onSave).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
  });
});
