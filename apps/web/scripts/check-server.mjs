#!/usr/bin/env node

// Pre-flight check: warn if the Goldpan server is not reachable.
// Runs before 'next dev' to catch the common mistake of starting
// web alone without the server. Always exits 0 — never blocks startup.

const serverUrl = process.env.GOLDPAN_SERVER_URL || 'http://localhost:3001';

try {
  const response = await fetch(`${serverUrl}/health`, {
    signal: AbortSignal.timeout(2000),
  });
  if (response.ok) {
    console.log(`✓ Goldpan server reachable at ${serverUrl}`);
  } else {
    printWarning(serverUrl, `responded with status ${response.status}`);
  }
} catch {
  printWarning(serverUrl, 'not reachable');
}

function printWarning(url, reason) {
  console.warn(`\n⚠ Goldpan server ${reason} at ${url}`);
  console.warn(`  Run 'pnpm dev' from the monorepo root to start both server and web.\n`);
}
