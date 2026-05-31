import { describe, expect, test } from 'vitest';
import { isAllowedWizardOrigin, isLocalAddress } from '../src/wizard-server.js';

describe('wizard-server trust boundary helpers', () => {
  test('recognizes loopback socket addresses', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalAddress('192.168.1.20')).toBe(false);
  });

  test('allows missing Origin for curl and same-machine tools', () => {
    expect(isAllowedWizardOrigin(undefined)).toBe(true);
  });

  test('allows browser origins from loopback hosts', () => {
    expect(isAllowedWizardOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedWizardOrigin('http://127.0.0.1:3000')).toBe(true);
  });

  test('rejects cross-site browser origins', () => {
    expect(isAllowedWizardOrigin('https://evil.example')).toBe(false);
  });
});
