# BYOK 自定义端点：封面生图 / 视频理解 渠道放开

> 记录最近三次提交的功能改动，便于回溯「为什么这么改」与「在哪里改的」。
> 工作区状态：本文档编写时工作区干净，无未提交改动。

## 背景

私有化 / 本地自建场景下，用户需要接入自建或已备案的 OpenAI 兼容中转端点（例如经 CLI Proxy 跑 Nano Banana 2 出图、跑 Gemini 3.x 理解视频）。此前 BYOK 的「封面生图」与「视频理解」两个功能被硬锁在火山方舟豆包（`doubao`）渠道，无法切换到自定义端点。这三次提交逐步放开该限制，同时保留原有的安全校验与合规口径。

涉及的三次提交（`local-docker` 分支，按时间倒序）：

| 提交 | 标题 |
|------|------|
| `da42962` | BYOK：加「自定义 OpenAI 兼容端点」渠道，base_url 可填、区域国内已备案 |
| `4c60a1a` | feat(cover): 封面生图支持自定义 OpenAI 兼容端点（custom 渠道） |
| `e8d2adf` | feat(video): 视频理解支持切换到 Gemini / custom 渠道 |

---

## 1. `da42962` — 新增 `custom` 渠道类型（BYOK base_url 可填）

**目标**：让 BYOK 支持任意 OpenAI 兼容端点，不再只有白名单供应商可选。

**改动**：

- [lib/constants.ts](../lib/constants.ts)
  - `LlmVendor` 类型加 `customEndpoint?: boolean`。
  - `LLM_VENDORS` 新增 `custom` 条目：`{ key: 'custom', name: '自定义 OpenAI 兼容端点', baseUrl: '', model: '', region: 'cn', customEndpoint: true }`。
  - `checkVendorEndpoint`：对 `customEndpoint: true` 的 vendor 跳过与预置 `baseUrl` 的比对，但仍做形状校验（`https://`、无 userinfo、无 query/hash），挡 SSRF 与 userinfo 陷阱。固定 vendor 仍走原「白名单」错误口径。
- [app/(app)/settings/ProviderForm.tsx](../app/(app)/settings/ProviderForm.tsx)
  - 选中 `custom` 时 `base_url` 输入框变为可编辑；合规区域固定「国内已备案」(cn) 且只读。
  - `submit` 用用户填的 `baseUrlInput` 作为 custom 的端点。
- [tests/settings/byok-endpoint.test.ts](../tests/settings/byok-endpoint.test.ts)
  - `custom` 从「被拒」名单移除；新增 `自定义端点渠道（custom vendor)` describe 块：合法 https 端点放行并归一、端到端入库 region=cn、形状不合法（http/userinfo/query/file）仍拒、末尾斜杠归一。
- [vitest.config.ts](../vitest.config.ts)
  - `exclude` 加 `data/**`，避免扫描本地 Postgres 数据目录。

**合规口径**：region 固定 `cn`（国内已备案）；出海仍走海外白名单供应商卡企业版。

---

## 2. `4c60a1a` — 封面生图支持 `custom` 渠道

**目标**：把「封面生图」(`image` 功能) 从只认 `doubao` 放开到也认 `custom`，例如经 CLI Proxy 跑 Nano Banana 2 出封面。

**改动**：

- [app/(app)/settings/FunctionRouting.tsx](../app/(app)/settings/FunctionRouting.tsx)
  - `image` 下拉额外放行 `custom`；`video` 仍只认 `doubao`。空列表提示分支化（image 提示「豆包或自定义端点」）。
- [app/(app)/settings/actions.ts](../app/(app)/settings/actions.ts)
  - `actSetRouting`：`image` 允许 `custom`，`video` 仍只认 `doubao`。
- [lib/llm/image.ts](../lib/llm/image.ts)
  - `ImageProvider` 类型加 `vendor: string`，让 `llmImage` 按哪家形状构造请求。
  - `resolveImageProvider`：查询含 `custom`，显式路由（`routing.image === p.id`）优先；`doubao` 兜底只复用 doubao 渠道（custom 没有默认图模型，不显式路由就不假设能生图）。ChatGPT / 平台 / env 各分支补 `vendor`。
  - `llmImage`：按 `provider.vendor` 分支构造 body——`doubao` 保留 `watermark: true` + 参考图（方舟专属）；`custom` 走纯 OpenAI `/images/generations` 形状（`model/prompt/size/response_format`），不带 `watermark` 与 `image` 参考图字段。响应解析（`data[].b64_json` / `data[].url`）共用不变。
  - `custom` 失败回 `detail.slice(0,180)` 原文，不走方舟专属 `explainArkError` 翻译；未配置错误文案补充 custom 选项。
- [lib/cover/run.ts](../lib/cover/run.ts)
  - 未配置提示文案补充 custom 选项。隐式 AIGC 标识注入逻辑不动（与 ChatGPT 订阅渠道同口径：custom 出图无服务端强制显式水印，靠隐式元数据兜底）。
- [app/(app)/settings/keys/page.tsx](../app/(app)/settings/keys/page.tsx)
  - `image` FN_META 改为「即梦 / 自定义端点」。
- [tests/llm/image-platform-channel.test.ts](../tests/llm/image-platform-channel.test.ts)
  - 新增 3 个 custom 路由用例：显式路由被采纳且 body 无 `watermark`、未路由不兜底、doubao+custom 共存仍走 doubao 兜底。

**关键设计**：`custom` 必须**显式路由**到 image 才用（不兜底）；`doubao` 仍零配置自动兜底，行为不变。

---

## 3. `e8d2adf` — 视频理解支持切换到 Gemini / custom

**目标**：把「视频理解」(`video` 功能) 从只认 `doubao` 放开到也认 `gemini` 与 `custom`，例如经 CLI Proxy 跑 Gemini 3.x 理解视频。

**改动**：

- [lib/llm/ark.ts](../lib/llm/ark.ts)
  - 新增 `videoPartForVendor(vendor, source, fps)`：
    - `doubao` → `{ type: 'video_url', video_url: { url, fps } }`（方舟私有口径，带 fps 抽帧）。
    - `gemini` / `custom` → `{ type: 'image_url', image_url: { url } }`（Gemini OpenAI 兼容口径，把视频当 `image_url` 传，不带 fps）。
  - 原 `videoPart` 保留（doubao 专用，测试仍用）。
- [lib/llm/gateway.ts](../lib/llm/gateway.ts)
  - `resolveVideoProvider`：返回 `{ provider, vendor } | null`，认 `doubao` + `custom` + `gemini`，显式路由优先；`doubao` 保留自动挑选（`looksVideoCapable` + 兜底），`custom`/`gemini` 仅显式路由时采用（没有可靠的「看着支持视频」启发式，不显式路由就不假设，避免把文本渠道默认拿去喂视频产生幻觉）。
  - `llmVideo`：签名从 `(tenantId, messages, opts)` 改为 `(tenantId, { system, source, fps, facts }, opts)`，内部按 `provider.vendor` 用 `videoPartForVendor` 构造视频内容块再拼 messages。未配置错误文案补充 custom/gemini 选项。
- [lib/video/analyze.ts](../lib/video/analyze.ts)
  - `video` 渠道调用点适配新签名；移除不再使用的 `videoPart` import。
- [app/(app)/settings/FunctionRouting.tsx](../app/(app)/settings/FunctionRouting.tsx)
  - `video` 下拉放行 `custom` + `gemini`；空列表提示同步。
- [app/(app)/settings/actions.ts](../app/(app)/settings/actions.ts)
  - `actSetRouting`：`video` 允许 `custom` + `gemini`。
- [app/(app)/settings/keys/page.tsx](../app/(app)/settings/keys/page.tsx)
  - `video` FN_META 改为「方舟 / Gemini / 自定义」。
- [app/(app)/library/page.tsx](../app/(app)/library/page.tsx)
  - `hasArkChannel` 门禁的渠道计数从 `vendor: 'doubao'` 放宽到 `vendor: { in: ['doubao','custom','gemini'] }`，确保路由到非豆包渠道时视频分析提交按钮不被禁用。
- [tests/llm/video-routing.test.ts](../tests/llm/video-routing.test.ts)
  - 新增 5 个路由用例：doubao 显式路由 → `video_url` 带 fps；gemini 显式路由 → `image_url` 不带 fps；custom 内联 data:URI → `image_url`；custom/gemini 未路由 → 不自动挑选（未配置）；doubao+gemini 共存未路由 → 仍自动挑选 doubao。
- [tests/video/analyze.test.ts](../tests/video/analyze.test.ts)
  - 适配 `llmVideo` 新签名（system 取值改为 `calls[0][1].system.content`）；新增 `videoPartForVendor` 用例。

**关键设计**：视频走 `/chat/completions`（HTTP 层本就 vendor 无关），唯一方舟专属的是消息里的 `video_url` 内容块 → 按 vendor 切换成 `image_url`。`custom`/`gemini` 必须**显式路由**才用；`doubao` 仍零配置自动兜底。

---

## 待确认的假设（执行实测时验证）

1. **封面生图**：CLI Proxy API 用 OpenAI 兼容 `/v1/images/generations` 暴露 Nano Banana 2，响应为标准 `{data:[{b64_json|url}]}`。若实际走 `/v1/chat/completions` 返回图片，需在 `llmImage` 另开一条 chat-completions 分支。
2. **视频理解**：Gemini / CLI Proxy 用 `image_url` 承载视频（`data:video/*` 内联或公网直链）。若代理要别的形状（`file_data` / `input_video`），在 `videoPartForVendor` 再加分支。

## 未改动的部分

- `doubao` 默认兜底逻辑、配额三道闸、`recordImageUsage` / `recordUsage`、连通性测试（`looksNonChatModel` 已能识别 image/video 模型，`routing.video/image === p.id` 即按非对话口径判定）均不动。
- 运维台 `/ops/ai` 侧的 image / video 路由本次未动，仍只认 `doubao`（用户走 BYOK 租户设置不受影响；如需平台侧一致可后续补）。
- 海外合规：`gemini` 为 `region: 'overseas'`，视频路由到 gemini 仍受既有海外使用口径约束。

## 验证

- 测试：`tests/llm/`、`tests/video/`、`tests/settings/` 共 17 个文件 256 个用例全过。
- 类型：`npx tsc --noEmit` 干净。

## 重建与实测

```bash
cd /work3/code/ai-media/beacon && \
docker compose --env-file .env.private -f docker-compose.private.yml build web && \
docker compose --env-file .env.private -f docker-compose.private.yml up -d --force-recreate web worker
```

实测步骤：
1. 在「接入与密钥」加一条 `custom` 渠道（baseUrl 指向 CLI Proxy，模型名填 Nano Banana 2 / Gemini 3.x 的模型标识）。
2. 「封面生图」/「视频理解」下拉应能看到该渠道，选中保存不报错。
3. studio / library 里触发生图或视频分析，观察是否走对应端点；若报「模型没有返回图片」或解析异常，即触发上面待确认的假设分支，回来调整请求形状。
