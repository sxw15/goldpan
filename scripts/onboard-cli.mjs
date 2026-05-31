#!/usr/bin/env node
/**
 * CLI mirror of the browser onboarding wizard. Targets headless / SSH-only
 * deploys where launching a Next.js wizard is impractical.
 *
 * Scope is intentionally narrow: language, web toggle, primary LLM provider
 * + key, classifier + extractor models, optional auth password. The same
 * extractor model is also written to matcher / comparator / verifier /
 * relator / intent / query so a 2-model CLI run produces a fully bootable
 * config. Digest, tracking, IM, embedding, multi-provider fine-tuning are
 * deliberately deferred to the browser wizard (`pnpm onboard`) — the CLI is
 * a fallback, not a replacement.
 *
 * Reuses `@goldpan/core/onboarding`'s writeEnvFile + validateStagedConfig +
 * applyMetadata so the validation / write semantics match the web wizard
 * (atomic `.env.tmp` rename, mode 0600, language metadata lock).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, isWizardHandle } from '@goldpan/core/bootstrap';
import { applyMetadata, validateStagedConfig, writeEnvFile } from '@goldpan/core/onboarding';
import prompts from 'prompts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '..');
const envPath = path.join(monorepoRoot, '.env');

// Best-effort language detection from POSIX `LANG`. Anything starting with
// zh* falls into the zh bucket; everything else defaults to en.
const lang = (process.env.LANG ?? '').toLowerCase().includes('zh') ? 'zh' : 'en';

const M =
  lang === 'zh'
    ? {
        heading: 'Goldpan 一键配置 CLI',
        intro:
          '只覆盖最小启动配置；digest / tracking / IM / embedding 等高级项请用 pnpm onboard 进入 web 向导。',
        langPrompt: '语言 / Language',
        webPrompt: '启用 web 管理界面？',
        providerPrompt: '主 LLM 提供商',
        apiKeyPrompt: (provider) => `${provider} API key`,
        baseUrlPrompt: (provider) => `${provider} base URL（留空使用默认）`,
        classifierPrompt: '分类（classifier）模型 — 推荐快/便宜',
        extractorPrompt: '抽取（extractor）模型 — 推荐能干',
        authRequired: '生产模式必须设管理员密码（≥8 字符）',
        authPrompt: '管理员密码（≥8 字符；留空跳过）',
        writing: (p) => `正在写入 ${p}...`,
        written: (p) => `配置已写入 ${p}（权限 0600）`,
        writeFailed: (msg) => `写入失败：${msg}`,
        writeFallback: '请手动复制以下内容到上述路径：',
        validationFailed: '配置校验失败：',
        cancelled: '已取消',
        next: '下一步：运行 pnpm start 启动；高级选项可用 pnpm onboard 进入 web 向导。',
        ollamaNote: 'ollama 本地部署，无需 API key',
        metadataSkipped: '元数据写入失败（不影响启动）：',
        required: '必填',
        minChars: '最少 8 字符',
        minCharsOrBlank: '最少 8 字符或留空',
      }
    : {
        heading: 'Goldpan one-click setup CLI',
        intro:
          'Covers only the minimum to boot. For digest / tracking / IM / embedding fine-tuning, run `pnpm onboard` (browser wizard).',
        langPrompt: 'Language',
        webPrompt: 'Enable web admin?',
        providerPrompt: 'Primary LLM provider',
        apiKeyPrompt: (p) => `${p} API key`,
        baseUrlPrompt: (p) => `${p} base URL (blank for default)`,
        classifierPrompt: 'Classifier model — fast/cheap',
        extractorPrompt: 'Extractor model — capable',
        authRequired: 'Production mode requires admin password (>=8 chars)',
        authPrompt: 'Admin password (>=8 chars; blank to skip)',
        writing: (p) => `Writing ${p}...`,
        written: (p) => `Config written to ${p} (mode 0600)`,
        writeFailed: (m) => `Write failed: ${m}`,
        writeFallback: 'Copy the following to that path manually:',
        validationFailed: 'Config validation failed:',
        cancelled: 'Cancelled',
        next: 'Next: run `pnpm start`. For advanced options, run `pnpm onboard` (browser wizard).',
        ollamaNote: 'ollama runs locally — no API key needed',
        metadataSkipped: 'Metadata seed skipped (does not block startup):',
        required: 'required',
        minChars: 'min 8 chars',
        minCharsOrBlank: 'min 8 chars or leave blank',
      };

// Defaults aligned with apps/web/src/app/onboarding/_components/step-card.tsx.
// If a model rev becomes outdated, the user can still edit `.env` manually —
// the CLI is just a starting point.
function defaultClassifier(provider) {
  if (provider === 'openai') return 'openai:gpt-4o-mini';
  if (provider === 'anthropic') return 'anthropic:claude-haiku-4-5-20251001';
  if (provider === 'deepseek') return 'deepseek:deepseek-chat';
  if (provider === 'google') return 'google:gemini-1.5-pro';
  if (provider === 'ollama') return 'ollama:qwen2.5:7b';
  return '';
}

function defaultExtractor(provider) {
  if (provider === 'openai') return 'openai:gpt-4o';
  if (provider === 'anthropic') return 'anthropic:claude-sonnet-4-20250514';
  if (provider === 'deepseek') return 'deepseek:deepseek-chat';
  if (provider === 'google') return 'google:gemini-1.5-pro';
  if (provider === 'ollama') return 'ollama:qwen2.5:14b';
  return '';
}

function escapeEnvValue(value) {
  if (value === '' || !/[\s#=`"'\\$]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function main() {
  console.log(M.heading);
  console.log(M.intro);
  console.log('');

  const requireAuth = process.env.NODE_ENV === 'production';

  const answers = await prompts(
    [
      {
        type: 'select',
        name: 'language',
        message: M.langPrompt,
        initial: lang === 'zh' ? 0 : 1,
        choices: [
          { title: '中文', value: 'zh' },
          { title: 'English', value: 'en' },
        ],
      },
      {
        type: 'toggle',
        name: 'webEnabled',
        message: M.webPrompt,
        initial: true,
        active: 'yes',
        inactive: 'no',
      },
      {
        type: 'select',
        name: 'provider',
        message: M.providerPrompt,
        choices: [
          { title: 'openai', value: 'openai' },
          { title: 'anthropic', value: 'anthropic' },
          { title: 'deepseek', value: 'deepseek' },
          { title: 'google (gemini)', value: 'google' },
          { title: `ollama (${M.ollamaNote})`, value: 'ollama' },
        ],
      },
      {
        type: (prev) => (prev === 'ollama' ? null : 'password'),
        name: 'apiKey',
        message: (prev) => M.apiKeyPrompt(prev),
        validate: (v) => (v && v.length > 0 ? true : M.required),
      },
      {
        type: (_prev, vals) =>
          vals.provider === 'openai' || vals.provider === 'deepseek' || vals.provider === 'ollama'
            ? 'text'
            : null,
        name: 'baseUrl',
        message: (_prev, vals) => M.baseUrlPrompt(vals.provider),
      },
      {
        type: 'text',
        name: 'classifierModel',
        message: M.classifierPrompt,
        initial: (_prev, vals) => defaultClassifier(vals.provider),
      },
      {
        type: 'text',
        name: 'extractorModel',
        message: M.extractorPrompt,
        initial: (_prev, vals) => defaultExtractor(vals.provider),
      },
      {
        type: 'password',
        name: 'authPassword',
        message: requireAuth ? M.authRequired : M.authPrompt,
        validate: (v) => {
          if (requireAuth && (!v || v.length < 8)) return M.minChars;
          if (v && v.length > 0 && v.length < 8) return M.minCharsOrBlank;
          return true;
        },
      },
    ],
    {
      onCancel: () => {
        console.log(M.cancelled);
        process.exit(1);
      },
    },
  );

  // Build staged keys. Use a Map (writeEnvFile expects Map<string, string>),
  // not an object — order is preserved when a key is appended for the first
  // time, which matters for human readers diffing the resulting `.env`.
  const staged = new Map();
  staged.set('GOLDPAN_LANGUAGE', answers.language);
  staged.set('GOLDPAN_WEB_ENABLED', String(answers.webEnabled));

  if (answers.provider === 'openai') {
    if (answers.apiKey) staged.set('OPENAI_API_KEY', answers.apiKey);
    if (answers.baseUrl) staged.set('OPENAI_BASE_URL', answers.baseUrl);
  } else if (answers.provider === 'anthropic') {
    if (answers.apiKey) staged.set('ANTHROPIC_API_KEY', answers.apiKey);
  } else if (answers.provider === 'deepseek') {
    if (answers.apiKey) staged.set('DEEPSEEK_API_KEY', answers.apiKey);
    if (answers.baseUrl) staged.set('DEEPSEEK_BASE_URL', answers.baseUrl);
  } else if (answers.provider === 'google') {
    if (answers.apiKey) staged.set('GOOGLE_GENERATIVE_AI_API_KEY', answers.apiKey);
  } else if (answers.provider === 'ollama') {
    if (answers.baseUrl) staged.set('OLLAMA_BASE_URL', answers.baseUrl);
  }

  if (answers.classifierModel) {
    staged.set('GOLDPAN_LLM_CLASSIFIER', answers.classifierModel);
  }
  if (answers.extractorModel) {
    // Apply the extractor model to the other 6 LLM steps as well. Browsing
    // wizard offers per-step picks; CLI users can refine later via web wizard
    // or by hand-editing `.env`. Two models is the floor for "feels working".
    for (const step of [
      'GOLDPAN_LLM_EXTRACTOR',
      'GOLDPAN_LLM_MATCHER',
      'GOLDPAN_LLM_COMPARATOR',
      'GOLDPAN_LLM_VERIFIER',
      'GOLDPAN_LLM_RELATOR',
      'GOLDPAN_LLM_INTENT',
      'GOLDPAN_LLM_QUERY',
    ]) {
      staged.set(step, answers.extractorModel);
    }
  }
  if (answers.authPassword) {
    staged.set('GOLDPAN_AUTH_PASSWORD', answers.authPassword);
  }

  // Validate before writing — same loadConfig() path bootstrap normal-mode
  // takes, so a green here means the server will boot with this `.env`.
  const stagedRecord = Object.fromEntries(staged);
  const validation = validateStagedConfig(stagedRecord);
  if (!validation.ok) {
    console.error(M.validationFailed);
    for (const err of validation.errors) {
      const errPath = Array.isArray(err.path) && err.path.length > 0 ? err.path.join('.') : '';
      console.error(`  - ${errPath ? `${errPath}: ` : ''}${err.message ?? ''}`);
    }
    process.exit(2);
  }

  console.log(M.writing(envPath));
  try {
    await writeEnvFile(envPath, staged);
    console.log(M.written(envPath));
  } catch (e) {
    // EACCES / EPERM / EROFS — file system refused our write. Echo content so
    // the user can paste into the right path themselves; better than dying
    // silently after they typed an API key.
    console.error(M.writeFailed(e instanceof Error ? e.message : String(e)));
    console.log(M.writeFallback);
    for (const [k, v] of staged) {
      console.log(`${k}=${escapeEnvValue(v)}`);
    }
    process.exit(3);
  }

  // Best-effort metadata seed. Open a wizard-mode bootstrap (lightweight,
  // skips plugin init) just to write `language` to the metadata table so
  // future wizard re-entries see the language as locked. If this fails (e.g.
  // DB path unwritable, sqlite-vec missing), just warn — the `.env` is
  // already on disk and the server will start fine.
  try {
    // Make sure bootstrap takes the wizard path even if the .env we just
    // wrote happens to be valid (auto mode would skip wizard then).
    process.env.GOLDPAN_FORCE_WIZARD = 'true';
    const handle = await bootstrap({ mode: 'wizard' });
    if (isWizardHandle(handle)) {
      applyMetadata(handle.metadataRepo, { language: answers.language });
    }
    await handle.shutdown();
  } catch (e) {
    console.warn(M.metadataSkipped, e instanceof Error ? e.message : String(e));
  }

  // If the user just authored the .env, sanity-check it is on disk before
  // hinting "next: pnpm start" — otherwise the next step would silently fail.
  if (!fs.existsSync(envPath)) {
    console.warn(`(${envPath} not found after write; check permissions.)`);
  }

  console.log('');
  console.log(M.next);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(10);
});
