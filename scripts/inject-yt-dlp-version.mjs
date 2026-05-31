#!/usr/bin/env node
/**
 * Print the pinned yt-dlp version from plugin source for Docker `--build-arg`.
 *
 * Usage: docker build --build-arg "YT_DLP_PINNED_VERSION=$(node scripts/inject-yt-dlp-version.mjs)" .
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const versionFile = join(here, '..', 'plugins', 'collector-media', 'src', 'yt-dlp-version.ts');
const content = readFileSync(versionFile, 'utf-8');
const match = content.match(/YT_DLP_PINNED_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!match) {
  console.error('Failed to extract YT_DLP_PINNED_VERSION from', versionFile);
  process.exit(1);
}
process.stdout.write(match[1]);
