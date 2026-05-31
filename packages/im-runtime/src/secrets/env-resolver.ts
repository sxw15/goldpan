import type { SecretResolver } from './resolver.js';

export class EnvSecretResolver implements SecretResolver {
  constructor(private env: Record<string, string | undefined> = process.env) {}

  resolve(ref: string): string {
    if (!ref.includes('://')) return ref;
    if (ref.startsWith('env://')) {
      const name = ref.slice('env://'.length);
      const value = this.env[name];
      if (value === undefined || value === '') {
        throw new Error(`SecretResolver: missing required env var: ${name}`);
      }
      return value;
    }
    throw new Error(`SecretResolver: unsupported secret scheme: ${ref.split('://')[0]}://`);
  }
}
