/**
 * CI check: ensure en.json and zh.json have identical key structures
 * and matching variable placeholders for both core and web locale files.
 * Also checks prompt file parity (every .md has a .zh.md).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@formatjs/icu-messageformat-parser';
import Handlebars from 'handlebars';

// ─── Helpers ─────────────────────────────────────────────────

function getLeafKeys(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [k, v] of getLeafKeys(value as Record<string, unknown>, fullKey)) {
        result.set(k, v);
      }
    } else if (typeof value === 'string') {
      result.set(fullKey, value);
    }
  }
  return result;
}

function extractVarNames(icuMessage: string): Set<string> {
  try {
    const ast = parse(icuMessage);
    const vars = new Set<string>();
    function walk(nodes: unknown[]) {
      for (const node of nodes) {
        const n = node as Record<string, unknown>;
        // type 1 = ArgumentElement, type 5 = SelectElement, type 6 = PluralElement
        if (n.type === 1 || n.type === 6 || n.type === 5) {
          vars.add(n.value as string);
        }
        if (n.options) {
          for (const opt of Object.values(n.options as Record<string, unknown>)) {
            const o = opt as Record<string, unknown>;
            if (o.value) walk(o.value as unknown[]);
          }
        }
        if (n.children) walk(n.children as unknown[]);
      }
    }
    walk(ast);
    return vars;
  } catch {
    // Fallback: simple regex extraction for non-ICU messages
    const vars = new Set<string>();
    for (const match of icuMessage.matchAll(/\{(\w+)\}/g)) {
      vars.add(match[1]);
    }
    return vars;
  }
}

// ─── Checks ──────────────────────────────────────────────────

const errors: string[] = [];

function checkLocaleParity(name: string, enPath: string, zhPath: string) {
  const en = JSON.parse(readFileSync(enPath, 'utf-8'));
  const zh = JSON.parse(readFileSync(zhPath, 'utf-8'));
  const enKeys = getLeafKeys(en);
  const zhKeys = getLeafKeys(zh);

  for (const key of enKeys.keys()) {
    if (!zhKeys.has(key)) errors.push(`[${name}] Key "${key}" missing in zh.json`);
  }
  for (const key of zhKeys.keys()) {
    if (!enKeys.has(key)) errors.push(`[${name}] Key "${key}" missing in en.json`);
  }

  for (const [key, enValue] of enKeys) {
    const zhValue = zhKeys.get(key);
    if (!zhValue) continue;
    const enVars = extractVarNames(enValue);
    const zhVars = extractVarNames(zhValue);
    for (const v of enVars) {
      if (!zhVars.has(v)) errors.push(`[${name}] Variable "{${v}}" in en "${key}" missing in zh`);
    }
    for (const v of zhVars) {
      if (!enVars.has(v)) errors.push(`[${name}] Variable "{${v}}" in zh "${key}" missing in en`);
    }
  }
}

function checkPromptParity(promptDir: string) {
  const files = readdirSync(promptDir).filter((f) => f.endsWith('.md'));
  const enFiles = files.filter((f) => !f.endsWith('.zh.md'));
  const zhFiles = files.filter((f) => f.endsWith('.zh.md'));
  for (const enFile of enFiles) {
    const zhFile = enFile.replace(/\.md$/, '.zh.md');
    if (!files.includes(zhFile)) {
      errors.push(`[prompts] Missing Chinese prompt: ${zhFile}`);
    }
  }
  for (const zhFile of zhFiles) {
    const enFile = zhFile.replace(/\.zh\.md$/, '.md');
    if (!files.includes(enFile)) {
      errors.push(`[prompts] Orphan Chinese prompt (no English counterpart): ${zhFile}`);
    }
  }
}

function checkPromptCompilation(promptDir: string) {
  const files = readdirSync(promptDir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    try {
      const content = readFileSync(join(promptDir, file), 'utf-8');
      Handlebars.compile(content);
    } catch (e) {
      errors.push(`[prompts] Handlebars compile failed for ${file}: ${(e as Error).message}`);
    }
  }
}

// S9: hardcoded user-visible attribute scan in apps/web/src/**/*.tsx.
// Boundary / loading pages intentionally use bilingual hardcoded strings
// (i18n provider may be unavailable when they render or async getTranslations
// would add a failure point during route transitions). Whitelist matches by
// monorepo-relative POSIX path, not basename — a deeper route-segment
// not-found.tsx must be added explicitly. Existence of each entry is verified
// at startup. Path is normalized to forward slashes for Windows safety.
const BOUNDARY_FILES = new Set([
  'apps/web/src/app/error.tsx',
  'apps/web/src/app/global-error.tsx',
  'apps/web/src/app/not-found.tsx',
  'apps/web/src/app/loading.tsx',
]);

// Negative lookbehind `(?<![-\w])` prevents the regex from matching after a
// hyphen or word char — so `data-title="…"` / `data-aria-label="…"` no longer
// false-positive as `title=` / `aria-label=`.

// Direct: split into double-quote and single-quote variants. Each excludes
// only its own delimiter from the value, so `placeholder="What's new?"` and
// `aria-label='Don’t click'` both match correctly.
const HARDCODED_ATTR_DQ_RE = /(?<![-\w])(aria-label|placeholder|title|alt)="([^"<>]+)"/g;
const HARDCODED_ATTR_SQ_RE = /(?<![-\w])(aria-label|placeholder|title|alt)='([^'<>]+)'/g;

// Brace expression: capture the whole `={…}` content (single line) and scan
// it for string literals. Catches conditional / logical branches like
// `aria-label={open ? "Close" : "Open"}` and `placeholder={value ?? "Search"}`
// which the old single-literal-only regex missed.
const HARDCODED_ATTR_BRACE_RE = /(?<![-\w])(aria-label|placeholder|title|alt)=\{([^}]+)\}/g;

// If the brace expression contains a function call (e.g., `t("close")`,
// `tCommon('close')`, `arr.join(' ')`) we treat it as legitimate dynamic logic
// and skip — string literals inside are likely arguments / filter values, not
// user text. This is a known trade-off vs full TSX AST parsing: a mixed
// expression like `isActive ? "Active" : t("inactive")` will be skipped.
const FUNCTION_CALL_IN_EXPR_RE = /\b\w+\s*\(/;
// If the brace expression contains template-literal interpolation (`${…}`)
// we treat it as dynamic and skip.
const TEMPLATE_INTERP_IN_EXPR_RE = /\$\{/;
// Within a brace expression, find any standalone string literal
// (single quote, double quote, or backtick template without interpolation).
const STRING_LITERAL_IN_EXPR_RE = /(['"`])((?:(?!\1).)+)\1/g;

function walkTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `[hardcoded-attr] symlink encountered at ${fullPath} — refuse to traverse (parity safety)`,
      );
    }
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walkTsxFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
      if (entry.name.endsWith('.test.tsx')) continue;
      out.push(fullPath);
    }
  }
  return out;
}

function checkBoundaryFilesExist(root: string) {
  for (const rel of BOUNDARY_FILES) {
    if (!existsSync(join(root, rel))) {
      errors.push(
        `[hardcoded-attr] BOUNDARY_FILES entry not found on disk: ${rel} — remove or rename in scripts/check-i18n-parity.ts`,
      );
    }
  }
}

function reportHardcoded(rel: string, lineNo: number, attr: string, value: string, brace: boolean) {
  // length<2 filters single-char placeholders like ` `, `…`, `+`
  if (value.length < 2) return;
  const display = brace ? `${attr}={…${value}…}` : `${attr}="${value}"`;
  errors.push(`[hardcoded-attr] ${rel}:${lineNo} ${display} — wrap with t() / useTranslations`);
}

function checkHardcodedAttrs(srcDir: string, root: string) {
  const files = walkTsxFiles(srcDir);
  for (const file of files) {
    // Normalize Windows backslash paths to POSIX so BOUNDARY_FILES (POSIX) matches.
    const rel = relative(root, file).replaceAll('\\', '/');
    if (BOUNDARY_FILES.has(rel)) continue;
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Direct string attributes: attr="..." and attr='...'
      for (const match of line.matchAll(HARDCODED_ATTR_DQ_RE)) {
        reportHardcoded(rel, i + 1, match[1], match[2], false);
      }
      for (const match of line.matchAll(HARDCODED_ATTR_SQ_RE)) {
        reportHardcoded(rel, i + 1, match[1], match[2], false);
      }
      // Brace expressions: attr={...} — scan the expression for string literals
      // unless it's a function call or template literal with interpolation.
      for (const match of line.matchAll(HARDCODED_ATTR_BRACE_RE)) {
        const attr = match[1];
        const expr = match[2];
        if (FUNCTION_CALL_IN_EXPR_RE.test(expr)) continue;
        if (TEMPLATE_INTERP_IN_EXPR_RE.test(expr)) continue;
        for (const litMatch of expr.matchAll(STRING_LITERAL_IN_EXPR_RE)) {
          reportHardcoded(rel, i + 1, attr, litMatch[2], true);
        }
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

checkLocaleParity(
  'core',
  join(root, 'packages/core/src/i18n/locales/en.json'),
  join(root, 'packages/core/src/i18n/locales/zh.json'),
);

checkLocaleParity(
  'web',
  join(root, 'apps/web/messages/en.json'),
  join(root, 'apps/web/messages/zh.json'),
);

checkPromptParity(join(root, 'packages/core/src/prompts'));

// Check that all prompt templates compile with Handlebars in both languages
checkPromptCompilation(join(root, 'packages/core/src/prompts'));

// S9: scan apps/web/src/**/*.tsx for hardcoded user-visible attribute literals
// (aria-label / placeholder / title / alt). Scope hard-coded to internal web —
// third-party web plugins live outside this tree and are unaffected.
checkBoundaryFilesExist(root);
checkHardcodedAttrs(join(root, 'apps/web/src'), root);

if (errors.length > 0) {
  console.error('i18n parity check failed:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
} else {
  console.log('✓ i18n parity check passed (6 checks)');
}
