import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PluginMeta } from './plugin-meta';

describe('PluginMeta', () => {
  it('renders name and version', () => {
    render(<PluginMeta name="GitHub Collector" version="0.1.0" />);
    expect(screen.getByText('GitHub Collector')).toBeInTheDocument();
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<PluginMeta name="X" version="1.0.0" description="Does the thing" />);
    expect(screen.getByText('Does the thing')).toBeInTheDocument();
  });

  it('omits description paragraph when undefined', () => {
    const { container } = render(<PluginMeta name="X" version="1.0.0" />);
    expect(container.querySelector('.gp-plugin-meta__description')).toBeNull();
  });

  it('omits description paragraph when empty string', () => {
    const { container } = render(<PluginMeta name="X" version="1.0.0" description="" />);
    expect(container.querySelector('.gp-plugin-meta__description')).toBeNull();
  });

  it('renders homepage link with target=_blank rel=noreferrer', () => {
    render(<PluginMeta name="X" version="1.0.0" homepage="https://example.com" />);
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('omits homepage anchor when undefined', () => {
    const { container } = render(<PluginMeta name="X" version="1.0.0" />);
    expect(container.querySelector('.gp-plugin-meta__homepage')).toBeNull();
  });
});
