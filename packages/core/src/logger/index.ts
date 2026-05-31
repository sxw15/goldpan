import { type ILogObj, Logger } from 'tslog';

export type { ILogObj, Logger };

const LOG_LEVEL_MAP = {
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
} as const;

type LogLevel = keyof typeof LOG_LEVEL_MAP;

export function createRootLogger(level: LogLevel = 'info'): Logger<ILogObj> {
  return new Logger({
    name: 'goldpan',
    minLevel: LOG_LEVEL_MAP[level],
    type: 'json',
    maskValuesOfKeys: [
      'apiKey',
      'api_key',
      'authorization',
      'token',
      'accessToken',
      'access_token',
      'refreshToken',
      'refresh_token',
      'password',
      'authPassword',
      'secret',
      'cookie',
      'sessionToken',
      'session_token',
      'x-api-key',
      'credentials',
      'privateKey',
      'private_key',
    ],
    maskValuesRegEx: [
      /sk-[A-Za-z0-9_-]{20,}/,
      /sk-ant-[a-zA-Z0-9_-]{20,}/,
      /AIza[a-zA-Z0-9_-]{35}/,
      /ghp_[A-Za-z0-9]{36}/,
      /Bearer\s+[A-Za-z0-9._-]{10,}/,
      /dsk-[A-Za-z0-9_-]{20,}/,
    ],
  });
}

export function createSubLogger(parent: Logger<ILogObj>, name: string): Logger<ILogObj> {
  return parent.getSubLogger({ name });
}
