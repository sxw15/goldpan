import { describe, expect, it } from 'vitest';
import { createRootLogger, createSubLogger } from '../src/logger/index.js';

describe('Logger', () => {
  it('creates root logger with default settings', () => {
    const logger = createRootLogger('info');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('creates sub-logger with name', () => {
    const root = createRootLogger('info');
    const sub = createSubLogger(root, 'core.pipeline');
    expect(sub).toBeDefined();
    expect(typeof sub.info).toBe('function');
    expect(sub.settings.name).toBe('core.pipeline');
  });

  it('respects log level', () => {
    const logger = createRootLogger('warn');
    expect(logger.settings.minLevel).toBe(4);
    const logs: unknown[] = [];
    logger.attachTransport((logObj) => logs.push(logObj));
    logger.info('should be suppressed');
    logger.debug('should be suppressed');
    logger.warn('should appear');
    expect(logs).toHaveLength(1);
  });

  it('masks sensitive keys in log output', () => {
    const logger = createRootLogger('info');
    const logs: unknown[] = [];
    logger.attachTransport((logObj) => logs.push(logObj));
    logger.info({ apiKey: 'sk-secret-12345', data: 'normal' });
    const output = JSON.stringify(logs[0]);
    expect(output).not.toContain('sk-secret-12345');
    expect(output).toContain('[***]');
  });

  it('masks API key patterns via regex', () => {
    const logger = createRootLogger('info');
    const logs: unknown[] = [];
    logger.attachTransport((logObj) => logs.push(logObj));
    logger.info('Token: sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    const output = JSON.stringify(logs[0]);
    expect(output).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  });
});
