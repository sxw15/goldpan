<div align="center">

# Goldpan

**AI 驱动的知识代谢系统 — 让信息消化像呼吸一样自然**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](https://nodejs.org)
[![GitHub Stars](https://img.shields.io/github/stars/sxw15/goldpan?style=social)](https://github.com/sxw15/goldpan)

<!-- TODO: hero gif 待补素材 -->
<!-- <img src="./docs/hero.gif" alt="Goldpan demo" width="720" /> -->

</div>

---

## 痛点:为什么做这个

如果你符合下面任何一条,Goldpan 就是给你做的:

1. **收藏夹是个坟场** — 保存 ≠ 消化,收藏的东西永远不会再看
2. **看到的时机和心智不匹配** — 娱乐时刷到技术文章,不想切换状态,但又怕错过
3. **同一话题被刷十次** — AI 时代信息门槛降低,同样的事被反复讲,浪费注意力
4. **找东西靠回忆,但平台太多** — 你知道见过,但不知道在哪
5. **想持续追一个话题,但靠人力盯太累** — RSS / 关键词搜索每天手动跑

---

## Goldpan 怎么解

- 🔄 **增量过滤** — 80% 已知的内容不再让你重复看
- 💬 **对话式知识** — 自然语言查询你的知识库,答案带源链接
- 🤖 **IM 即输入** — 转发链接到 Telegram,2 秒完成消化
- 🔌 **全可插拔** — Collector / Intent / Tool / IM / Web 五层全可替换
- 🏠 **自托管优先** — SQLite 零基础设施,数据全在你本地

---

## 它是什么 / 不是什么

**是**:AI 驱动的知识代谢系统。输入(链接 / 文本 / IM 转发) → 自动消化 → 增量入库 → 对话输出 + 日报推送。

**不是**:
- ❌ 笔记软件 — 不需要你手动整理
- ❌ 推荐系统 — 不猜你喜好,不做个性化 feed
- ❌ 社交平台 — 你的数据不会喂给任何人

---

## Demo

<!-- TODO: 主流程 GIF 待补素材 -->
<!-- <img src="./docs/demo-main.gif" alt="主流程演示" width="720" /> -->

<!-- TODO: 截图待补素材 — 知识库浏览页 / 对话页 / 日报页 -->

🎥 演示视频(即将上线)

---

## 60 秒开跑

```bash
git clone https://github.com/sxw15/goldpan.git goldpan
cd goldpan
pnpm install
pnpm onboard           # 浏览器向导起 server + web,自动跳 8 步配置
```

打开浏览器跟着配置向导走,完成。

> 详细配置 / LLM provider 选项 / 自定义 web / 完整环境变量表请见 [INSTALL.md](./INSTALL.md)

---

## 它怎么工作

<!-- TODO: 架构图待补素材 -->
<!-- <img src="./docs/architecture.svg" alt="架构图" /> -->

Goldpan 的核心是一条 9 步 pipeline:

```
collect    采集页面 / GitHub / 文本
   ↓
classify   LLM 给内容分类、贴标签
   ↓
extract    抽出原子知识点
   ↓
match      把知识点对到已有实体(或新建)
   ↓
relate     抽实体间关系("公司 A 收购公司 B")
   ↓
compare    🌟 增量比对,过滤已知
   ↓
verify     LLM 自检
   ↓
validate   结构校验
   ↓
store      写入 SQLite + FTS5 + sqlite-vec
```

**本地优先**:所有数据、配置、日志全在你机器上的 SQLite。除了你主动调用的 LLM provider(OpenAI / Anthropic / Gemini / 你自己的 Ollama 等,你自己选),没有任何数据出网。


---

## 插件系统

**为什么有插件**

Goldpan core 是骨架,**任何接入新数据源、新平台、新能力的诉求都通过插件实现**。Core 本身不知道任何具体平台 SDK(Telegram、GitHub、Tavily 都是插件加进来的),好处:

- **你只用一部分能力**:只想要 web,不想要 IM ?不装 IM 插件就行
- **你完全替换某一层**:默认 Next.js web UI 不喜欢?用 `GOLDPAN_WEB_PACKAGE` 换成你自己的前端
- **不用 fork 全仓库**:插件作为独立 npm 包发布即可

**5 类插件**

| 类型 | 做什么 | 内置例子 |
|---|---|---|
| **Collector** | 把内容从源头抓回来 | `collector-browser`(Playwright)、`github-collector` |
| **Intent** | 识别用户在 IM / web 里发了啥意图 | `github-intent`(识别 `refresh_github` 命令) |
| **Tool** | 给 LLM 用的工具 | `tool-search-tavily` / `serper` / `google` |
| **IM** | 接入即时通讯平台 | `im-telegram` |
| **Web** | 替换 / 定制前端 UI | 默认 `apps/web`,可用 `GOLDPAN_WEB_PACKAGE` 换 |

**60 秒创建一个 collector**

```typescript
// plugins/your-collector/src/index.ts
import {
  type CollectorPlugin,
  parseCollectedHtml,
} from '@goldpan/core/plugins';

export const goldpanPlugin: CollectorPlugin = {
  type: 'collector',
  name: '@goldpan/plugin-collector-myservice',
  version: '0.1.0',
  description: 'Collector for myservice.com',
  priority: 5,
  canHandle: (input) => input.url.startsWith('https://myservice.com/'),
  async collect(input, signal) {
    const res = await fetch(input.url, { signal });
    const html = await res.text();
    return parseCollectedHtml(html, res.url);
  },
};
```

放进 `plugins/your-collector/`,跑 `pnpm -r build && pnpm dev`,server 启动时自动注册。完整 5 类插件的接口、`PluginContext`、`settingsContribution` 等细节由 `docs/plugin-guide.md` 单独维护(陆续完善中)。

**怎么贡献插件**

两条路径:

1. **提 PR 进本仓库** — 路径 `plugins/<name>/`,跟随 monorepo 一起发布。适合通用 / 高质量 / 想被官方维护的插件
2. **独立维护** — 发到 npm,包名遵循 `@goldpan/plugin-*` 约定,用户自己装到他们的 `plugins/` 目录。适合实验性 / 小众 / 想自己掌控的插件

未来计划:**插件市场**(设置页一键安装),当前 disabled 等接通后开放。


---

## 推荐给朋友

如果 Goldpan 解决了你的痛点,欢迎告诉别人。**复制下面这段就能转发**:

> 我在用一个叫 Goldpan 的自托管开源工具:把所有读到的文章 / 视频 / GitHub 项目自动消化成结构化知识库,最关键的是会做"增量比对" —— 同样话题刷十次,它只告诉你新内容。如果你也被收藏坟场困扰,强推:https://github.com/sxw15/goldpan

⭐ **Star History**

[![Star History Chart](https://api.star-history.com/svg?repos=sxw15/goldpan&type=Date)](https://star-history.com/#sxw15/goldpan&Date)

发 issue 或 discussion 让作者知道你在用、想要什么、卡在哪 —— 自托管项目最需要的就是真实用户的反馈。

---

## 商业模式(透明)

**现在**:100% 自托管开源工具。**没有 SaaS、没有付费墙、没有强推付费版的计划**。

**未来可能**(用"可能",不是承诺):

- **托管版(Hosted)** — 替不想 self-host 的用户跑一份 Goldpan,省去 self-host / 配置 / 升级。开源版本一切能力保留
- **KOL 知识订阅** — 让某领域专家用 Goldpan 维护公开知识库,其他人订阅。商业模式待验证
- **企业版** — 多用户 / 团队权限 / SSO 等企业特性。**「未来可能」,不是承诺**

**承诺**:

- ✅ **AGPL-3.0 永远不变**。不会做"core 是 AGPL,关键功能闭源"这种 license 切换
- ✅ **自托管能力永远保留**。任何商业版能做的事,self-host 版都能做(可能配置麻烦一点,但能做)

---

## License

**[AGPL-3.0](./LICENSE)**

人话解释:

- 你**个人 self-host / fork / 改代码 / 写插件** → 完全不受影响,想怎么用怎么用
- 你拿 Goldpan **给团队 / 朋友圈子内部用** → 也不受影响("内部使用"不触发 AGPL 网络条款)
- 唯一受限场景:**你拿 Goldpan 作为公开 SaaS 给陌生人提供服务,必须把你的衍生作品也以 AGPL 开源**

这是为了防云厂商白嫖,**不是为了限制你**。

---

## 核心技术栈

- [Vercel AI SDK](https://ai-sdk.dev) — LLM provider 抽象层
- [Next.js](https://nextjs.org) — Web 框架
- [Drizzle ORM](https://orm.drizzle.team) — SQLite ORM + migration
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — SQLite 向量搜索
- [grammy](https://grammy.dev) — Telegram bot 框架
- [Hono](https://hono.dev) — HTTP server

---

## FAQ

**Q:为什么用 SQLite?多用户怎么办?**
A:SQLite 零基础设施,单文件备份 / 同步 / 迁移都简单 —— 自托管个人工具的最优解。多用户 V1 不支持,未来可能引入(不破坏 self-host 体验为前提)。

**Q:我的数据会出去吗?**
A:所有内容、关系、配置、日志全在你机器上的 SQLite。唯一出网的是你主动调用的 LLM provider(OpenAI / Anthropic / Gemini / 你自己的 Ollama 等,你自己选)。

**Q:必须配 LLM provider 吗?能完全离线吗?**
A:必须配(pipeline 多步依赖 LLM)。完全离线方案:用 Ollama 跑本地模型 —— 见 [INSTALL.md](./INSTALL.md)。

**Q:我能贡献插件 / PR 吗?**
A:欢迎。两条路径见上面的插件系统章节。

---

## Links

- 📖 [INSTALL.md](./INSTALL.md) — 完整部署 / 配置 / LLM provider
- 📝 [CHANGELOG.md](./CHANGELOG.md) — 变更历史
- 🤝 [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献指南
- 🏛️ [LICENSE](./LICENSE) — AGPL-3.0
- 💬 [GitHub Issues](https://github.com/sxw15/goldpan/issues) / [Discussions](https://github.com/sxw15/goldpan/discussions) — Bug 反馈 / 提案
