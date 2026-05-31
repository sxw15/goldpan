> 完整产品介绍见 [README.md](./README.md)

# Goldpan

A knowledge extraction pipeline powered by LLMs.

## First-time setup

新部署 Goldpan 推荐先跑一遍配置向导。三种入口：

### 浏览器向导（推荐）

```bash
git clone <repo> && cd goldpan/monorepo
pnpm install
pnpm onboard          # 等价 GOLDPAN_FORCE_WIZARD=true pnpm dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)，自动跳转 8 步向导：基本配置 → Pipeline LLM → Digest → Tracking → IM → Embedding → 鉴权密码 → 完成。最后一页点「一键重启」会进入 normal mode（前提是用 `pnpm start:supervised` 或 docker；详见下方）。

### 命令行向导（headless / SSH）

无桌面环境用 CLI mirror：

```bash
pnpm onboard:cli
```

只覆盖最小必要配置（语言 / web 开关 / 主 LLM provider + key / classifier + extractor 模型 / auth 密码）。其它高级项后续可通过浏览器向导精调。

### Docker 部署

```bash
docker compose up
```

容器启动时自动检测缺失配置进入向导模式。向导写入存到 `data/goldpan.db` 的 `runtime_config_overrides` 表，**不再写 `.env`** —— `.env` 卷以 `ro` 只读挂载也完全可以。docker-compose.yml 已写好 `./data` 挂载示例，自部署时按需调整。

### 一键重启依赖：supervisor

向导的「一键重启」需要某种重启 supervisor。三种推荐方式：

| 部署方式 | 命令 | 一键重启行为 |
|---|---|---|
| Docker | `docker compose up` | 容器重启策略接管 |
| 裸机生产 | `pnpm start:supervised` | scripts/supervised-start.mjs 监听 exit 0 自重启 |
| 开发 | `pnpm dev` | concurrently 不重启；向导显示「请手动重启」提示 |

裸 `pnpm start`（无 supervisor）会进入 60s polling 超时分支，提示用户手动重启。

如配置已稳定不需要再走向导，删除 `GOLDPAN_FORCE_WIZARD` 环境变量即可。

## Language Configuration

Set `GOLDPAN_LANGUAGE` in your `.env` file:

- `en` (default) — English
- `zh` — Chinese

Language is locked per-deployment: the first run persists the chosen language into the database. Changing `GOLDPAN_LANGUAGE` after the database contains data will cause a startup error. To switch languages, create a new database.

## 配置存储

UI 修改的配置存到本地 SQLite (`runtime_config_overrides` 表),**不再修改 `.env` 文件**。

- 重新部署时,baseline 由 `.env` / docker env / k8s ConfigMap 提供,UI 写的 override 在此之上叠加。
- DB override 永远优先于 `.env`。改 `.env` 后重启,如果同一个 key 在 DB 也有 override,生效的还是 DB 值。
- 设置页"导出 overrides"按钮可以把当前 override 导出成 `.env` 片段,合并回部署 env 后重新部署即可"声明式固化"当前配置。
- `GOLDPAN_AUTH_PASSWORD` 和 `GOLDPAN_LANGUAGE` 影响 `apps/web` 进程。改这两个 key 后,先用"导出 overrides"同步到 `.env` / docker env / k8s Secret 或 ConfigMap,再同时重启 server 和 web 服务;否则 web 会继续读取旧 baseline。

完整模型与 origin 三态徽章见 `.agent/env.md` 的"运行时配置 override"章节。

## 启动

前置：Node ≥ 22；在 `monorepo` 根目录已执行 `pnpm install`。

1. 在仓库根目录从 `.env.example` 复制并编辑 `.env`（填写 API Key 等）。
2. 在 `monorepo` 根目录启动开发服务（server + web 同时启动）：

```bash
pnpm dev
```

这会通过 `concurrently` 同时启动 server（端口 3001）和 web（端口 3000）。终端会以蓝色和绿色分别显示 server 和 web 的日志。

浏览器访问 [http://localhost:3000](http://localhost:3000)。

也可以单独启动：

```bash
# 仅启动 server（API + pipeline worker）
pnpm server:dev

# 仅启动 web（需要 server 已在运行；启动时会检查 server 可达性）
pnpm --filter @goldpan/web dev
```

生产构建与启动：

```bash
pnpm -r build
pnpm start
```

生产环境必须设置 `GOLDPAN_AUTH_PASSWORD`（至少 8 位），否则无法通过配置校验。

## Docker

### All-in-one 模式

单容器运行 server + web：

```bash
docker compose up goldpan
```

### Split 模式

Web 和 server 分开运行（web 可独立扩容）：

```bash
docker compose --profile split up
```

Split 模式下 `goldpan-web` 会等待 `goldpan-worker` 健康检查通过后再启动。

## 替换内置 web UI

如果你想用自己的前端替换 `apps/web`：

1. 在 `monorepo/plugins/web-<id>/` 放一个 workspace 包（任何 HTTP server 技术栈都行：Next.js / Vue / SvelteKit / Hono / Express / 静态站 preview server / FastAPI 等）。`package.json` 必须包含 `scripts.start`、`scripts.dev`，以及 `goldpan.web.displayName`。
2. 在 `.env` 设 `GOLDPAN_WEB_PACKAGE=@goldpan/plugin-web-<id>`。
3. 跑 `pnpm web:list` 确认包被识别，然后 `pnpm dev` / `pnpm start` 跟平时一样。

替换包**不能** `import @goldpan/core`，只通过 HTTP 跟 `apps/server` 对话（JS/TS 客户端用 `@goldpan/web-sdk`）。完整契约 + 字段表见 [`docs/superpowers/specs/2026-05-03-web-plugin-protocol-design.md`](../docs/superpowers/specs/2026-05-03-web-plugin-protocol-design.md)。

## 外置插件

Goldpan 通过约定目录 `monorepo/plugins/*` 支持外置采集器插件。`apps/server` 启动时会自动扫描该目录、加载每个插件的 `dist/index.js` 并注册到 `PluginRegistry`。

### 工作原理

采集器按**优先级从高到低**依次尝试。高优先级插件失败时自动回退到下一个，`collector-web`（优先级 0）始终作为兜底：


| 插件                  | 优先级 | 说明                                     |
| ------------------- | --- | -------------------------------------- |
| `collector-browser` | 10  | 使用 Playwright 无头浏览器渲染，支持 SPA / JS 动态页面 |
| `collector-web`（内置） | 0   | HTTP 静态抓取 + Readability 提取，兜底方案        |


### 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 构建全部（含外置插件）
pnpm -r build

# 3. 启动（server + web 同时启动）
pnpm dev
```

无需额外配置，`collector-browser` 会自动注册并优先处理所有 HTTP/HTTPS 页面。

### Playwright 浏览器配置

环境变量 **`GOLDPAN_BROWSER_STRATEGY`**（默认 **`auto`**）控制 `collector-browser` 如何启动浏览器：

| 取值 | 行为 |
| --- | --- |
| `auto` | 先尝试本机已安装的 **Google Chrome**（Playwright `channel: 'chrome'`，无需手写路径）；失败则回退到 Playwright 自带的 Chromium。 |
| `system-chrome` | 只使用本机 Google Chrome；未安装时会报错并回退到下一个采集器（如 `collector-web`）。 |
| `bundled` | 只使用 Playwright 下载的 Chromium；需事先执行安装命令（见下）。 |

若设置了 **`GOLDPAN_BROWSER_EXECUTABLE_PATH`**，将**始终**使用该可执行文件，并忽略上述策略。

无系统 Chrome、且希望仅用自带 Chromium 时：

```bash
pnpm --filter @goldpan/plugin-collector-browser exec playwright install chromium
```

也可显式指定 Chrome 路径（适用于非标准安装位置）：

```
GOLDPAN_BROWSER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

### 编写自定义插件

在 `monorepo/plugins/` 下新建目录，遵循以下约定：

```
monorepo/plugins/your-plugin/
├── package.json          # name 以 @goldpan/plugin- 开头
├── tsconfig.json
└── src/
    └── index.ts          # 必须导出 export const goldpanPlugin: CollectorPlugin
```

- `package.json` 的 `name` 必须匹配 `@goldpan/plugin-*` 模式
- 入口模块必须导出命名导出 `goldpanPlugin`，类型为 `CollectorPlugin`
- 构建产物入口为 `dist/index.js`
- 可复用核心包的共享能力：

```typescript
import {
  parseCollectedHtml,  // HTML → Markdown 解析（与 collector-web 一致的输出格式）
  validateSsrf,        // SSRF 防护校验
  CollectorError,      // 统一错误类型
} from '@goldpan/core/plugins';
```

放入 `monorepo/plugins/` 后，server 启动时自动发现和注册，无需修改任何接线代码。

### 手动安装第三方 plugin

设置页"插件 → 安装新插件"按钮目前 disabled（registry install 未实装）。手动安装步骤：

1. **放置目录**：把 plugin 包放到 `monorepo/plugins/<name>/`，须含 `package.json` + `dist/index.js`（或可 build 出 `dist/index.js` 的 `tsconfig.json` + `src/index.ts`）。
2. **构建**：`pnpm -r build` 让 plugin 一起编译。
3. **重启 server**：`pnpm server:start`。设置页"插件"组刷新后会出现新条目。

**排查清单**（plugin 没出现）：
- `dist/index.js` 是否生成？build 失败时 server 启动会跳过该 plugin（看 startup log）。
- `package.json` 的 `name` 字段是否合法 npm package 名？
- 入口必须命名导出 `goldpanPlugin`（默认导出无效）。
- 设置页 envKeys 来自 plugin 自描述（`goldpanPlugin.settingsContribution`）；要让"前往配置"按钮跳转，需要在 `apps/server/src/routes/plugin-config-group-map.ts` 登记 plugin slug → group（详见 `.agent/plugins.md`）。

## 全删依赖再安装

在 `monorepo` 根目录执行（会删除所有 `node_modules` 与 Next 构建缓存 `apps/web/.next`，然后按 lockfile 重装）：

```bash
find . -depth -type d -name node_modules -exec rm -rf {} +
rm -rf apps/web/.next
pnpm install
```

若出现被忽略的构建脚本警告且运行异常，可再执行 `pnpm approve-builds` 按需放行。

## LLM Providers

Goldpan supports any provider exposed by the [Vercel AI SDK](https://ai-sdk.dev/providers/ai-sdk-providers)
plus self-hosted via Ollama and arbitrary OpenAI-compatible endpoints. Each
pipeline step (classifier / extractor / matcher / relator / comparator /
verifier / intent / query / digest_summary / digest_action) takes a model id
of the form `<provider>:<model>`.

Built-in providers and where to find their model ids:

| Provider | API key env | Where to look up model ids |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/docs/models |
| Anthropic | `ANTHROPIC_API_KEY` | https://docs.anthropic.com/en/docs/about-claude/models |
| Google (Gemini) | `GOOGLE_GENERATIVE_AI_API_KEY` | https://ai.google.dev/gemini-api/docs/models |
| DeepSeek | `DEEPSEEK_API_KEY` | https://api-docs.deepseek.com/quick_start/pricing |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/models |
| Ollama (self-hosted) | — (uses `OLLAMA_BASE_URL`) | https://ollama.com/library |

Custom OpenAI-compatible providers (Together / Mistral / Groq / Fireworks /
Anyscale / etc.) can be added via `Settings → Engine → LLM → Add Provider`
or by setting the `GOLDPAN_LLM_PROVIDER_<ID>_BASE_URL` /
`GOLDPAN_LLM_PROVIDER_<ID>_API_KEY_ENV` env pair.

Pipeline model assignments are editable in `Settings → Engine → LLM →
Pipeline 模型分配`. Saved values are written as DB overrides on top of the
`.env` baseline and take effect immediately (no server restart). For details
see `.agent/env.md` § 运行时配置 override 模型.
