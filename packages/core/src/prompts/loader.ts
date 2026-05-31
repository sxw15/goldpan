import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Handlebars from 'handlebars';
import type { LlmStep } from '../db/repositories/types';
import { getLanguage } from '../i18n';
import type { Language } from '../i18n/types';

export type PromptTemplateName = LlmStep | `${LlmStep}-system`;

// Resolves to the directory containing the prompt .md templates.
// Native Node.js / tsx: import.meta.dirname points to the source directory.
// Turbopack virtualizes import.meta, so we fall back to CWD-based paths
// matching the known monorepo layout.
const TEMPLATE_DIR = resolveTemplateDir();

function resolveTemplateDir(): string {
  if (import.meta.dirname) return import.meta.dirname;

  const fromApp = resolve(process.cwd(), '../../packages/core/src/prompts');
  if (existsSync(fromApp)) return fromApp;

  const fromRoot = resolve(process.cwd(), 'packages/core/src/prompts');
  if (existsSync(fromRoot)) return fromRoot;

  throw new Error('Cannot find prompts template directory');
}

// Templates are loaded once per process lifetime and cached. Prompt file
// changes require a process restart to take effect.
const templateSourceCache = new Map<string, string>();
const compiledTemplateCache = new Map<string, Handlebars.TemplateDelegate>();

/**
 * Load a prompt template by step name and language.
 * Templates are .md files co-located in src/prompts/.
 */
export function loadPromptTemplate(step: PromptTemplateName, language: Language): string {
  const cacheKey = `${step}:${language}`;
  const cached = templateSourceCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const fileName = language === 'zh' ? `${step}.zh.md` : `${step}.md`;
  const filePath = join(TEMPLATE_DIR, fileName);
  try {
    const content = readFileSync(filePath, 'utf-8');
    templateSourceCache.set(cacheKey, content);
    return content;
  } catch (error) {
    throw new Error(
      `Failed to load prompt template "${step}" (${language}) from ${filePath}: ${(error as Error).message}`,
    );
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    // Prevent XML tag breakout in gp_ delimited blocks (both opening and closing)
    return value.replace(/<\/gp_/gi, '</ gp_').replace(/<gp_/gi, '< gp_');
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitized[k] = sanitizeValue(v);
    }
    return sanitized;
  }
  return value;
}

function sanitizePromptVariables(variables: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(variables) as Record<string, unknown>;
}

/**
 * Compile a Handlebars template string with the given variables.
 * Uses triple-stash {{{ }}} for DB text fields (no HTML escaping).
 */
export function compilePrompt(templateStr: string, variables: Record<string, unknown>): string {
  let compiled = compiledTemplateCache.get(templateStr);
  if (!compiled) {
    compiled = Handlebars.compile(templateStr, { noEscape: false });
    compiledTemplateCache.set(templateStr, compiled);
  }
  return compiled(sanitizePromptVariables(variables));
}

/**
 * Compute SHA-256 hash of prompt template content (first 8 hex chars).
 * Accepts variadic string parts joined with NUL separator.
 * Used for prompt version tracking in llm_calls.prompt_hash.
 */
export function computePromptHash(first: string, ...rest: string[]): string {
  const combined = rest.length === 0 ? first : [first, ...rest].join('\0');
  return createHash('sha256').update(combined).digest('hex').slice(0, 8);
}

/**
 * Clear the template cache. Useful for testing.
 */
export function clearTemplateCache(): void {
  templateSourceCache.clear();
  compiledTemplateCache.clear();
}

/**
 * Build a plugin-local prompt loader bound to a directory. Plugins colocate
 * their own `.md` prompt files and don't share the core `PromptTemplateName`
 * enum, so they instantiate this factory with their own directory. Reading,
 * Handlebars compilation and hashing reuse the central helpers in this file —
 * keep all prompt-loading behavior in one place.
 */
export function createPluginPromptLoader(options: {
  dir: string;
  label?: string;
}): (step: string, isSystem: boolean) => string {
  const { dir, label = 'plugin' } = options;
  // Per-factory source cache so repeated intent invocations don't re-read
  // the same prompt file. Mirrors `templateSourceCache` used by core's
  // `loadPromptTemplate`. Keyed by filepath, so language switches naturally
  // resolve to the other file without collision.
  const sourceCache = new Map<string, string>();
  return (step: string, isSystem: boolean): string => {
    const lang = getLanguage();
    const suffix = isSystem ? '-system' : '';
    const filename = lang === 'en' ? `${step}${suffix}.md` : `${step}${suffix}.${lang}.md`;
    const filepath = join(dir, filename);
    const cached = sourceCache.get(filepath);
    if (cached !== undefined) return cached;
    if (!existsSync(filepath)) {
      throw new Error(`Missing ${label} prompt: ${filename}`);
    }
    const content = readFileSync(filepath, 'utf-8');
    sourceCache.set(filepath, content);
    return content;
  };
}
