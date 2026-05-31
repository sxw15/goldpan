import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { EnvFallbackModal } from './env-fallback-modal';

const LABELS = {
  heading: '写入 .env 失败',
  desc: 'docker 只读挂载，请手动写入',
  copyButton: '复制全部',
  closeLabel: '关闭',
  revealButton: '显示明文',
  hideButton: '重新遮蔽',
  maskedNote: '敏感字段已默认遮蔽',
};

describe('EnvFallbackModal', () => {
  const SAMPLE = [
    'GOLDPAN_LANGUAGE=zh',
    'OPENAI_API_KEY=sk-proj-1234567890ABCDEF',
    'GOLDPAN_AUTH_PASSWORD=hunter2pad',
    '',
  ].join('\n');

  test('default render masks secret values and shows masked note', () => {
    render(
      <EnvFallbackModal envContent={SAMPLE} onClose={vi.fn()} onCopy={vi.fn()} labels={LABELS} />,
    );
    // Non-secret stays visible
    expect(screen.getByText(/GOLDPAN_LANGUAGE=zh/)).toBeInTheDocument();
    // Secrets are redacted (no plaintext leak)
    const pre = screen.getByText(/GOLDPAN_LANGUAGE=zh/);
    expect(pre.textContent).not.toContain('sk-proj-1234567890ABCDEF');
    expect(pre.textContent).not.toContain('hunter2pad');
    expect(pre.textContent).toContain('OPENAI_API_KEY=sk-••••••DEF');
    expect(pre.textContent).toContain('GOLDPAN_AUTH_PASSWORD=hun••••••pad');
    // Mask note is visible
    expect(screen.getByText(LABELS.maskedNote)).toBeInTheDocument();
  });

  test('reveal toggle shows plaintext and hides note', () => {
    render(
      <EnvFallbackModal envContent={SAMPLE} onClose={vi.fn()} onCopy={vi.fn()} labels={LABELS} />,
    );
    fireEvent.click(screen.getByRole('button', { name: LABELS.revealButton }));
    const pre = screen.getByText(/GOLDPAN_LANGUAGE=zh/);
    expect(pre.textContent).toContain('OPENAI_API_KEY=sk-proj-1234567890ABCDEF');
    expect(pre.textContent).toContain('GOLDPAN_AUTH_PASSWORD=hunter2pad');
    expect(screen.queryByText(LABELS.maskedNote)).toBeNull();
    // Toggle back
    fireEvent.click(screen.getByRole('button', { name: LABELS.hideButton }));
    expect(screen.getByText(LABELS.maskedNote)).toBeInTheDocument();
  });

  test('copy and close callbacks fire; copy always uses original content (caller responsibility)', () => {
    const onClose = vi.fn();
    const onCopy = vi.fn();
    render(
      <EnvFallbackModal envContent={SAMPLE} onClose={onClose} onCopy={onCopy} labels={LABELS} />,
    );
    fireEvent.click(screen.getByRole('button', { name: LABELS.copyButton }));
    expect(onCopy).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: LABELS.closeLabel }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
