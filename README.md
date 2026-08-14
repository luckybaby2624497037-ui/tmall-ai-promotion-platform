# 天猫AI推广半自动化平台（前后端）

多店铺天猫广告投放半自动化运营平台：内置 **11 个功能板块、61 个可交互技能、10 个平台工具**，支持阿里妈妈开放平台（万相台无界版/直通车/引力魔方/达摩盘/生意参谋）真实数据接入，未配置时自动使用**演示模式**体验全部功能。

## 项目简介

- **后端**（`server.js`）：纯 Node.js 内置模块实现（`http`/`fs`/`path`/`url`/`crypto`），**零 npm 依赖**，提供：
  - 淘宝/阿里妈妈 OAuth2.0 授权（登录 → 授权 → 回调 → Token 管理 → 刷新 → 退出）
  - 阿里妈妈开放 API 签名网关代理（HMAC-MD5 签名，`eco.taobao.com/router/rest`）
  - 静态文件服务与 CORS 支持
- **前端**（`public/index.html`）：单页应用，包含平台总览、板块与技能、平台工具三大 Tab，61 个技能全部可交互；内置统一数据适配层（`DataAdapter`），在"演示数据"与"阿里妈妈实时数据"之间自动切换。

## 架构图（文本）

```
┌─────────────────────────────────────────────────────────────┐
│                     浏览器 (public/index.html)               │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │ 61个技能组件  │  │ 10个平台工具      │  │ 店铺登录/授权  │  │
│  └──────┬───────┘  └────────┬─────────┘  └───────┬───────┘  │
│         └──────────┬────────┴────────────────────┘          │
│              ┌─────▼──────────────────┐                      │
│              │ DataAdapter 数据适配层  │ mode: demo | real   │
│              └─────┬──────────────────┘                      │
└────────────────────┼─────────────────────────────────────────┘
                     │ fetch (同源 /api/*)
┌────────────────────▼─────────────────────────────────────────┐
│                server.js (Node.js, 零依赖)                    │
│  /api/auth/login    → 生成 OAuth 授权 URL                     │
│  /api/auth/callback → 换取 access_token (postMessage 回传)    │
│  /api/auth/refresh  → 刷新 Token                              │
│  /api/auth/status   → 授权店铺列表与过期状态                    │
│  /api/auth/logout   → 移除 Token                              │
│  /api/proxy/alimama → TOP 网关签名代理 (HMAC-MD5)             │
│  /api/health        → 健康检查                                │
│  内存存储: sessions(Map) + tokens(Map userId→token)           │
└──────────┬───────────────────────────┬───────────────────────┘
           │ HTTPS (内置 fetch)        │ 静态文件
┌──────────▼───────────┐   ┌───────────▼──────────┐
│ oauth.taobao.com     │   │ public/index.html    │
│ eco.taobao.com       │   │ (前端SPA)            │
│ (阿里妈妈开放平台)     │   └──────────────────────┘
└──────────────────────┘
```

## 本地启动方法

要求 Node.js >= 18（推荐 22，使用内置 `fetch`）：

```bash
cd tmall-platform
node server.js
# 或
npm start
```

打开 http://localhost:8081 即可。未配置 appKey 时点击"店铺登录"会提示进入**演示模式**，全部 61 个技能与 10 个工具均可体验。

如需接入真实数据，先配置环境变量（可参考 `.env.example`，Windows PowerShell 示例）：

```powershell
$env:TAOBAO_APP_KEY="你的appKey"
$env:TAOBAO_APP_SECRET="你的appSecret"
$env:TAOBAO_REDIRECT_URI="http://localhost:8081/api/auth/callback"
node server.js
```

Linux/macOS：

```bash
export TAOBAO_APP_KEY=你的appKey
export TAOBAO_APP_SECRET=你的appSecret
export TAOBAO_REDIRECT_URI=http://localhost:8081/api/auth/callback
node server.js
```

> 注意：本项目零依赖，不需要 `npm install`，也没有加载 `.env` 文件的逻辑，环境变量请通过 shell 注入或部署平台配置。

## 部署到 Vercel 说明

项目根目录已包含 `vercel.json`：

```json
{
  "version": 2,
  "builds": [{ "src": "server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

部署步骤：

1. 安装 Vercel CLI：`npm i -g vercel`
2. 在项目根目录执行 `vercel`，按提示登录并确认
3. 在 Vercel 项目 Settings → Environment Variables 中配置：
   - `TAOBAO_APP_KEY`
   - `TAOBAO_APP_SECRET`
   - `TAOBAO_REDIRECT_URI`（改为 `https://你的域名/api/auth/callback`）
   - `SESSION_SECRET`
4. 执行 `vercel --prod` 发布生产环境
5. 在阿里妈妈开放平台应用管理中，把回调地址更新为 Vercel 线上地址

> 提示：server.js 使用内存 Map 存储 Token，Vercel Serverless 实例重启后会丢失。生产长期使用建议将 `tokens` 存储替换为数据库（如 Supabase/Redis）。

## 环境变量说明

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TAOBAO_APP_KEY` | 接入真实数据时必填 | 阿里妈妈开放平台应用 appKey |
| `TAOBAO_APP_SECRET` | 接入真实数据时必填 | 阿里妈妈开放平台应用 appSecret，用于 HMAC-MD5 签名 |
| `TAOBAO_REDIRECT_URI` | 否 | OAuth 回调地址，默认 `http://localhost:8081/api/auth/callback` |
| `SESSION_SECRET` | 否 | 会话密钥（预留） |
| `PORT` | 否 | 监听端口，默认 `8081` |
| `HOST` | 否 | 监听地址，默认 `0.0.0.0` |

## 如何申请阿里妈妈开放平台权限

1. **登录开放平台**：访问 [阿里妈妈开放平台](https://www.alimama.com) （open.alimama.com），使用天猫店铺主账号或服务商账号登录，完成企业实名认证。
2. **创建应用获得 appKey/appSecret**：进入"应用管理 → 创建应用"，选择"自用型应用"（服务自己店铺）或"工具型ISV应用"（服务他人店铺），创建后在应用详情页获得 `appKey` 与 `appSecret`，填入本项目环境变量。
3. **申请万相台无界版 API 权限包**：在"API 权限申请"中申请 **万相台无界版（营销投放）API 权限包**、直通车/引力魔方报表权限、达摩盘人群权限与生意参谋数据权限，提交资质审核（通常需要店铺授权书与营业执照）。
4. **配置回调地址**：在应用"授权回调地址"中填写本项目回调：本地 `http://localhost:8081/api/auth/callback`，线上改为 `https://你的域名/api/auth/callback`，必须与 `TAOBAO_REDIRECT_URI` 完全一致，否则授权会失败。

审核通过后，重启 server.js 并在前端点击"店铺登录 → 通过淘宝授权登录"，授权成功即进入实时数据模式（顶栏出现"实时"徽标，右下角数据源状态显示"阿里妈妈API(已连接)"）。

## 已对接的 API 列表

前端 `DataAdapter` 按以下 method 调用后端 `/api/proxy/alimama`（真实模式）：

| 能力 | TOP method（示例） | 说明 |
| --- | --- | --- |
| 万相台计划查询 | `alimama.zw.campaign.list` | 万相台无界版计划列表（分页） |
| 万相台计划报表 | `alimama.report.campaign.get` | 按日期区间拉取计划级投放报表 |
| 关键词查询 | `alimama.zw.keyword.list` | 计划关键词列表与出价/质量分 |
| 人群（达摩盘） | `alimama.dmp.crowd.list` | DMP 人群包列表与覆盖量 |
| 创意素材 | `alimama.creative.list` | 创意列表与审核状态 |
| 生意参谋数据 | `alimama.sycm.summary.get` 等生意参谋数据接口 | 店铺流量/交易/转化核心指标 |

> 说明：以上 method 名称以阿里妈妈开放平台实际文档为准；即便某 method 尚未在你的应用白名单内，网关仍会透传调用并**原样返回上游报错**，便于联调时对照权限包开通状态。演示模式下这些接口均返回内置种子数据，功能体验完全一致。

## 二次开发指引

1. **新增数据能力**：在 `public/index.html` 的 `DataAdapter` 中新增 `fetchXxx()`，真实分支调用 `POST /api/proxy/alimama {userId, method, params}`，演示分支返回种子数据；再在 `getStores()` 或对应技能中消费。
2. **新增技能**：参照 `MODULES` 数组（`render:'renderSxx'`），在脚本末尾新增 `window.renderSxx = function(mod, skill){...}`，卡片与搜索自动收录。
3. **新增平台工具**：在 `TOOLS` 数组追加 `{id,name,icon,color,desc,render}` 并实现渲染函数。
4. **后端新增接口**：在 `server.js` 的 `handleApi` 中追加路由分支；需要调用 TOP 网关时复用 `signRequest()` 与 `postForm()`。
5. **持久化 Token**：把 `tokens` Map 读写替换为数据库（Supabase/MySQL/Redis），`/api/auth/*` 与 `/api/proxy/alimama` 中的存取点已集中、易替换。
6. **回调页通信**：`callbackPage()` 通过 `window.opener.postMessage` 回传授权结果，若嵌入第三方系统可扩展 payload 字段。
7. **前端语法校验**：改动后建议抽出 `<script>` 内容跑 `node --check` 验证语法。
