import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Tag } from './tag';

describe('Tag', () => {
  test('renders with todo kind class', () => {
    const { container } = render(<Tag kind="todo">未实现</Tag>);
    const span = container.querySelector('.gp-tag');
    expect(span).not.toBeNull();
    expect(span?.className).toContain('gp-tag--todo');
    expect(span?.textContent).toBe('未实现');
  });

  test.each([
    'live',
    'restart',
    'env',
    'readonly',
    'default',
    'beta',
    'todo',
    'shadowed',
  ] as const)('accepts %s kind', (kind) => {
    const { container } = render(<Tag kind={kind}>x</Tag>);
    expect(container.querySelector(`.gp-tag--${kind}`)).not.toBeNull();
  });
});
