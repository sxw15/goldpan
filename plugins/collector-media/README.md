# @goldpan/plugin-collector-media

视频 collector，通过 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 接入 YouTube / Bilibili / Vimeo 的视频元数据 + 字幕。

## 架构

- `priority: 20` — 在 `collector-browser`（priority 10）和 `collector-web`（priority 0）之前
- `canHandle` 命中视频白名单 hosts（精确 + subdomain，拒绝 `fake-youtube.com` / `youtube.com.evil.tld` 这类伪造域名）
- 所有失败 `terminal=true`：registry 不 fallback 到 browser/web —— 否则视频 URL 会被 browser 当 SPA 抓播放器 shell 喂给 pipeline
- `getCollectTimeoutMs()` 返回 90s 默认（可通过 `GOLDPAN_MEDIA_COLLECT_TIMEOUT` 覆盖）；独立于全局 `GOLDPAN_COLLECT_TIMEOUT`（30s）

## 支持的站点

第一期：YouTube / Bilibili / Vimeo。配置在 `src/supported-sites.json`。

## 加站点

1. 改 `src/supported-sites.json` 加一项 `{ name, hosts: [...] }`
2. 在 `tests/fixtures/` 放 `yt-dlp -J <url>` 的真实输出 + 对应字幕 VTT
3. 加单测 验证 fixture 能 parse + markdown 输出 snapshot
4. 提 PR

## yt-dlp 二进制管理

Plugin 自管 binary（不探测系统 PATH 中的 yt-dlp）：

- 默认 lazy 下载（首次视频请求前；plugin initialize 时 fire-and-forget prefetch 缓解延迟）
- 自动升级（24h 缓存 GitHub latest）
- SHA256 校验所有下载
- Docker 镜像预装 `YT_DLP_PINNED_VERSION`（启动 0 延迟）

用户控制：

| Env | 效果 |
|---|---|
| `GOLDPAN_YT_DLP_BINARY_PATH=/path/to/yt-dlp` | 跳过下载/升级，用外部 binary |
| `GOLDPAN_YT_DLP_AUTO_UPDATE=false` | 关自动升级，只用本地 PINNED 版本 |
| `GOLDPAN_YT_DLP_VERSION=2026.01.15` | 钉死特定版本（覆盖 auto-update） |
| `GOLDPAN_YT_DLP_DIR=/path/to/dir` | 自定义 binary + version.txt 存放位置（默认 `${dataDir}/yt-dlp`） |
| `GOLDPAN_YT_DLP_UPDATE_CHECK_INTERVAL_H=24` | GitHub latest 查询缓存小时数 |

手动 CLI（紧急通道，反爬变更时；先 `pnpm server:build` 一次让 dist 存在）：

```bash
pnpm --filter @goldpan/server start yt-dlp upgrade
pnpm --filter @goldpan/server start yt-dlp status
pnpm --filter @goldpan/server start yt-dlp install --version=2026.02.10
```

`status` 输出含 `binaryPath`（实际平台命名，例如 `yt-dlp_linux`/`yt-dlp_macos`）和 `exists` 字段。
`upgrade` 同步等待新版本下载完成，并打印是否真的发生升级。

## Cookie

B 站会员视频 / YouTube 关闭字幕的私有视频需要 cookie：

```bash
GOLDPAN_YT_DLP_COOKIES_PATH=/path/to/cookies.txt
```

cookies.txt 格式按 yt-dlp 标准（Netscape cookie format）。配错路径 plugin 仍会启动（log warning，公开视频继续可用）。

## 错误码

所有错误 `terminal=true`，code 映射：

| Code | 场景 | retryable |
|---|---|---|
| `NOT_FOUND` | private / video unavailable / removed | `false` |
| `INVALID_REQUEST` | geo-block / login required / members-only | `false` |
| `RATE_LIMIT` | HTTP 429 / Too Many Requests | `true` |
| `UPSTREAM` | HTTP 5xx | `true` |
| `CONTENT_EMPTY` | 视频可访问但无字幕（人工 + 自动都没） | `false` |
| `FETCH_FAILED` | 网络 / binary 问题 | `true` |
| `PARSE_FAILED` | yt-dlp 输出 JSON 解析失败 | `false` |
| `TIMEOUT` | collect 超时（90s 默认） | `true` |
| `ABORTED` | 外部 abort signal | `false` |

## 输出格式

`CollectorOutput.content` 是 markdown：

```markdown
# <title>

- **Uploader**: <uploader>
- **Channel**: <channel>
- **Published**: YYYY-MM-DD
- **Duration**: 1h 15m 30s
- **URL**: https://...

## Description

<description, omitted if empty>

## Transcript (en, manual)

<deduped subtitle text>
```

`CollectorOutput.metadata` 字段（全部 `collector_video_*` 前缀）：`id`, `uploader`, `channel`, `duration_sec`, `subtitle_lang`, `subtitle_kind`（`manual`|`auto`）, `upload_date`（ISO）。

## 测试

```bash
# 单测（mock spawn / fetch）
pnpm --filter @goldpan/plugin-collector-media test

# 集成测试（真实 yt-dlp + YouTube）
GOLDPAN_INTEGRATION_TESTS=true pnpm --filter @goldpan/plugin-collector-media test -- integration
```

集成测试默认 skip，CI 不跑。fixture URL 失败时 skip 而非 fail，避免 YouTube 政策变化让本地集成测试莫名挂。
