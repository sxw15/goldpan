# Contributing to Goldpan

Thanks for considering a contribution. This repo follows three core
disciplines — read them before opening a PR.

1. **架构纪律** — 装配代码上浮到 `apps/*`；低层库不反向依赖高层。
   依赖只能从高层指向低层；跨层装配放在 `apps/*` 或明确的 composition
   layer，不要下沉到被复用的库里。
2. **设计纪律** — 先找根因再动手；修复让防御代码减少而不是增多。
   拿到 bug 先问"为什么"出现，再问"怎么消失"。如果修复需要多处加
   防御、引 flag、要求每个调用方"记得"做某事 —— 大概率没找到根因。
3. **防御纪律** — 先找中央化点再加防御；不在 consumer 侧重复同主题
   防御。Grep 同主题的中央化点（`sanitize*` / `escape*` / `validate*`
   / `*Middleware` / `*Limiter` / `auth*`）和相关 `*.test.ts`。

## Commands

All commands run from the repo root.

```bash
pnpm install
pnpm -r build
pnpm test            # vitest + i18n parity
pnpm lint            # Biome (NOT ESLint/Prettier)
```

Full command list: see `package.json` scripts.

## Pipeline data-flow discipline

`PipelineContext.collectorMetadata` is a collector-authored JSON blob.
Only `collecting.ts` is allowed to touch it — it writes the field onto
`ctx` and persists it to `sources.metadata` via
`sourceRepo.updateAfterCollecting`.

**Middle pipeline steps (classifying / extracting / matching / relating
/ comparing / verifying / validating / storing) must NOT read
`ctx.collectorMetadata`.** If a middle step needs a new collector
signal, add a typed field to `PipelineContext` at the `collecting.ts`
boundary (see `updateMode` for the reference pattern — it narrows the
string to a discriminated union before the rest of the pipeline ever
sees it).

Why: reading arbitrary `collector_*` JSON keys in middle steps makes
core pipeline logic depend on collector-authored strings, which the
type system cannot constrain — the exact coupling the R3 refactor
removed.

Verify with:

```bash
grep -rn "collectorMetadata" packages/core/src/pipeline/steps/
```

Expected match: only `collecting.ts` (writes + persists). Any other
match is a violation — add a typed field at the `collecting.ts`
boundary instead.

## Where to put new code

- `packages/core/` — reusable library code (pipeline, DB, LLM,
  plugins, i18n)
- `packages/im-runtime/` — IM channel runtime primitives (no business
  pipeline imports)
- `packages/web-sdk/` — framework-agnostic HTTP client + types (no
  `@goldpan/core` imports)
- `apps/server/` — standalone HTTP + worker process; 装配 pipeline +
  plugins
- `apps/web/` — Next.js UI; talks to `apps/server` via
  `@goldpan/web-sdk`
- `plugins/*` — collector / intent / tool / IM plugins

Assembly code (wiring plugins, choosing providers, loading env) lives
in `apps/*` — never inside `packages/` or `plugins/`.

## License

By contributing, you agree your contributions will be licensed under
the AGPL-3.0 License — same as the project (see [LICENSE](./LICENSE)).
