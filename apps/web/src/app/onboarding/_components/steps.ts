// apps/web/src/app/onboarding/_components/steps.ts
//
// Single source of truth for the wizard's step list. Used by:
//   - ProgressBar to render the stepper (only visible steps appear)
//   - Each page's SettingsHead to derive «step N / total» crumb numbers
//   - Each page's Back / Next buttons to look up adjacent visible step hrefs
//
// To temporarily hide a step without deleting it, flip `hidden: true` on its
// entry — the stepper, crumb counts, and Back/Next nav targets all skip it.
// The route file stays on disk and the URL still renders if a user navigates
// to it directly; this is intentional so the work isn't lost while a step is
// pulled from the visible flow.

export type StepSlug =
  | 'basic'
  | 'pipeline'
  | 'digest'
  | 'tracking'
  | 'im'
  | 'embedding'
  | 'auth'
  | 'complete';

export interface StepDef {
  slug: StepSlug;
  href: string;
  /** When true, omit from the stepper / crumb / nav. Route file stays. */
  hidden?: boolean;
  /** Terminal page — reachable via Back/Next nav but excluded from the
   *  stepper rendering and crumb count. The commit page after the last
   *  config step is the canonical user — there's no further "step" to
   *  do, so showing a "6/6" pip is just visual noise. */
  terminal?: boolean;
}

export const STEPS: readonly StepDef[] = [
  { slug: 'basic', href: '/onboarding' },
  { slug: 'pipeline', href: '/onboarding/pipeline' },
  // embedding 暂时从向导隐藏：默认 disabled，启用 vector 检索的用户在「设置 →
  // Embedding」里配置；保留 step file / state 字段 / commit 序列化路径，方便后续
  // 加回。详见 pipeline/page.tsx 底部的 hint。
  { slug: 'embedding', href: '/onboarding/embedding', hidden: true },
  { slug: 'digest', href: '/onboarding/digest', hidden: true },
  { slug: 'tracking', href: '/onboarding/tracking', hidden: true },
  { slug: 'im', href: '/onboarding/im' },
  // auth 暂时从向导隐藏：onboarding 流程到 IM 步骤就提交配置；用户后续通过设置页
  // 配置 Bearer 密码。route file / commit-handler 路径保留，方便后续加回（也方便
  // 直接访问 /onboarding/auth 的开发者）。详见 im/page-client.tsx 的提交按钮。
  { slug: 'auth', href: '/onboarding/auth', hidden: true },
  { slug: 'complete', href: '/onboarding/complete', terminal: true },
];

/** Steps the stepper renders + included in crumb counting. */
export const VISIBLE_STEPS: readonly StepDef[] = STEPS.filter((s) => !s.hidden && !s.terminal);

/** Steps reachable via Back/Next nav. Terminal page stays here so `auth`'s
 *  "next" still routes to `/onboarding/complete`. */
const NAV_STEPS: readonly StepDef[] = STEPS.filter((s) => !s.hidden);

/** 1-based index of `slug` among visible steps; suitable for «N / total». */
export function visibleIndex(slug: StepSlug): number {
  const i = VISIBLE_STEPS.findIndex((s) => s.slug === slug);
  return i >= 0 ? i + 1 : 1;
}

export function visibleTotal(): number {
  return VISIBLE_STEPS.length;
}

/** Href of the next nav step after `slug`. Returns the last nav step's href
 *  if `slug` is the last (or hidden — defensive fallback). */
export function nextVisibleHref(slug: StepSlug): string {
  const i = NAV_STEPS.findIndex((s) => s.slug === slug);
  if (i < 0 || i >= NAV_STEPS.length - 1) {
    return NAV_STEPS[NAV_STEPS.length - 1].href;
  }
  return NAV_STEPS[i + 1].href;
}

/** Href of the previous nav step before `slug`. Returns the first nav
 *  step's href if `slug` is the first (or hidden — defensive fallback). */
export function prevVisibleHref(slug: StepSlug): string {
  const i = NAV_STEPS.findIndex((s) => s.slug === slug);
  if (i <= 0) return NAV_STEPS[0].href;
  return NAV_STEPS[i - 1].href;
}

/** True if `slug` is the last *config* step the user sees (last entry of
 *  VISIBLE_STEPS). The page in question should render a "提交配置" button
 *  driven by `useWizardCommit` instead of a "下一步" nav button. */
export function isLastVisibleStep(slug: StepSlug): boolean {
  if (VISIBLE_STEPS.length === 0) return false;
  return VISIBLE_STEPS[VISIBLE_STEPS.length - 1].slug === slug;
}
