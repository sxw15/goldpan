#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs';

const pluginDirs = globSync('plugins/im-*');
let failed = 0;
if (pluginDirs.length === 0) {
  console.error('[channel-send-check] no im-* adapter packages found under plugins/');
  process.exit(1);
}
for (const dir of pluginDirs) {
  const sources = globSync(`${dir}/src/**/*.ts`);
  if (sources.length === 0) {
    console.error(`[channel-send-check] ${dir} has no TypeScript sources under src/`);
    failed++;
    continue;
  }
  const hit = sources.some((file) => /installSendReply\s*\(/.test(readFileSync(file, 'utf8')));
  if (!hit) {
    console.error(
      `[channel-send-check] ${dir}: no source under src/ calls installSendReply(fn) — ` +
        'every im-* adapter must install its send-reply function so IMRuntime.sendOutbound works',
    );
    failed++;
  }
}
if (failed > 0) {
  console.error(`channel adapter send check failed (${failed} issue(s))`);
  process.exit(1);
}
console.log(`channel adapter send check passed (${pluginDirs.length} adapter(s))`);
