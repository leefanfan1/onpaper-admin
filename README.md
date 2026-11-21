# OnPaper Admin

管理 [OnPaper](https://github.com/leefanfan1/astro-theme-onpaper) 主题博客的 Cloudflare Worker 面板。

一个面板管任意多个仓库：文章、页面与友链、书架、站点配置、媒体库、Actions 任务、审计日志。

面板是遥控器，不是执行器。内容读写走 GitHub API，`npm run covers` 这类脚本在 GitHub Actions 上跑——关掉面板、手机断网，任务照样跑完。

---

## 为什么这样设计

**脚本不在 Worker 里跑。** `covers` 要用 `node:fs` 写文件、用 `sharp` 重编码图片，`og` 还要起 Playwright 的 Chromium，豆瓣会拦数据中心 IP。workerd 一样都做不到。

GitHub Actions 的执行环境和本机一致，主题仓库的脚本一行都不用改。面板只负责三件事：dispatch 一个 workflow、记住 run id、回来时对账。

**读走 GraphQL，写走 REST。** REST Contents API 一次只能读一个文件，14 篇文章就是 14 次往返。GraphQL 一次返回整个目录的 blob 文本。

**编辑是外科式的。** `src/config.ts` 用 acorn 定位值所在的源码区间，只替换那几个字符，注释、`satisfies`、`as` 断言、引号风格、缩进都不动。frontmatter 同理：只改真的变了的字段和行，没建模的 key 原样保留。

---

## 快速开始

```bash
npm install
npm run build        # 构建前端到 dist/web
npm run dev          # 本地起服务
```

打开 http://127.0.0.1:8787 。

本地开发需要 `.dev.vars`（已在 `.gitignore`）：

```
GITHUB_PAT=ghp_xxx
SESSION_SECRET=<openssl rand -base64 32>
DEV_AUTH_EMAIL=dev@localhost
```

`wrangler.dev.jsonc` 里 `REQUIRE_ACCESS: "false"`，跳过 Access。

---

## 部署

### 1. 建资源

```bash
npx wrangler d1 create onpaper-admin
npx wrangler d1 execute onpaper-admin --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute onpaper-admin --remote --file=./migrations/0002_site_url.sql
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create STORE
```

把返回的三个 id 填进 `wrangler.jsonc` 对应的占位符。

### 2. 配密钥

```bash
npx wrangler secret put GITHUB_PAT
npx wrangler secret put SESSION_SECRET
```

`GITHUB_PAT` 是 fine-grained PAT，需要 **Contents: RW**、**Actions: RW**、**Workflows: RW**。

`SESSION_SECRET` 是 base64 编码的 32 字节，用来加密每站点独立存放的令牌。

### 3. 配 Access

在 Cloudflare Zero Trust 里为面板域名建一个 Access 应用，策略选允许你的邮箱。然后把三个值填进 `wrangler.jsonc`：

```jsonc
"ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
"ACCESS_AUD": "从 Access 应用概览页复制",
"PANEL_HOSTNAME": "admin.example.com"
```

### 4. 部署

```bash
npm run deploy
```

### 5. 建第一个站点

打开面板 →「站点」→「连接仓库」，填 `owner/repo`、分支、站点发布地址。点「检查连接」会验证令牌权限和主题结构。

### 6. 装任务通道

面板 →「任务」→「安装任务通道」。它会写入 `.github/workflows/admin-task.yml`。装完在仓库的 Actions 页面允许这个 workflow 运行。

---

## 功能

| 分区 | 内容 |
| --- | --- |
| **文章** | 新建 / 编辑 / 删除 / 改网址；结构化 frontmatter 表单；Markdown 编辑 + 沙箱预览（支持音乐卡片、GitHub 卡片、B 站 / YouTube / Spotify / Vimeo 嵌入、KaTeX、Mermaid）；上传 `.md` 导入；下载原文；批量发布 / 置顶 / 删除 |
| **页面与友链** | `about.md`；`now.md` 的「在听 / 在读 / 在看」三段表单；`friends.md` 增删改排序 |
| **书架** | 书单 / 片单 / 歌单逐条增删改；封面状态；一键触发 `covers`（可只补某条） |
| **站点配置** | 站名、描述、作者、导航、社交链接、13 个颜色 token（带对比度检查）、界面语言、功能开关、OG 模板源码 |
| **媒体** | 上传 / 删除 / 重命名；查引用（删图前告诉你有几篇文章在用它） |
| **任务** | `covers`、`music`、`og`、`build`、`test:*` 的触发、状态、步骤级结果、改动摘要、取消 |
| **提交 / 审计** | 仓库提交历史；面板内的每次写入记录 |

**手机**：主要使用场景。底部固定栏四个入口，书架三列，编辑页单栏切换写作 / 预览，触控目标 ≥ 44px。

**主题的 i18n**：`siteConfig.i18n.defaultLang` 决定构建期界面语言（面板里能改）；导航项可写字典 `key`；文章自带 `lang` 字段。老主题的配置和文章不会被写入这些新字段。

---

## 安全

| 层 | 措施 |
| --- | --- |
| 认证 | Cloudflare Access 在门外；Worker 再独立验一遍 JWT（RS256 / JWKS / `aud` 绑定 / `exp` / `nbf`）；验完还要在 D1 用户表里 |
| 域名 | Host 不匹配一律拒绝——否则 `*.workers.dev` 会完全绕过 Access |
| 路径 | 白名单。拒绝 `.github/**`、`package.json`、`scripts/**`、`*.mjs`、`..`、编码绕过、Windows 保留名、`public/` 下的 SVG |
| 注入 | workflow 参数经 `env:` 间接传参，表达式不进 `run:`；面板侧再校验字符集 |
| CSRF | `Origin` 精确匹配 + `X-Panel-CSRF` 头 + D1 里的会话令牌，三重校验 |
| XSS | 预览消毒后放进 `sandbox="allow-scripts"` 的 iframe（**没有** `allow-same-origin`）；CSP 无 `unsafe-inline` 脚本 |
| 上传 | 查 magic bytes、像素数上限、尺寸上限；SVG 一律拒绝 |
| 令牌 | 只在 Worker secret；每站点令牌 AES-GCM 加密存 D1；日志和错误信息脱敏 |
| 限流 | 每个写操作有配额，防止一个会话烧掉 GitHub 额度 |
| 并发 | 保存前校验 `sha`，文件被改过就拒绝覆盖并提示刷新 |

---

## 目录

```
src/worker/            Worker 侧
  index.ts             入口：/api/* 给 Hono，其余给静态资源 + 安全头
  api.ts               路由挂载
  middleware.ts        身份、CSRF、限流、审计、错误翻译
  sites.ts             站点记录与令牌
  tasks.ts             Actions 触发与对账
  store.ts             D1 / KV 双后端
  workflow-template.ts 任务通道模板

  routes/              API
    posts.ts           文章 CRUD、批量操作、保存预览
    pages.ts           三个页面
    shelf.ts           三份清单
    config.ts          src/config.ts 编辑
    media.ts           图片
    tasks.ts           任务
    sites.ts           站点
    admin.ts           用户、审计、总览、提交历史
    markdown.ts        .md 导入与下载
    warm.ts            缓存预热

  lib/
    paths.ts           路径白名单（安全边界）
    frontmatter.ts     frontmatter 读写
    content.ts         书架 / 最近 / 友链解析
    config-edit.ts     config.ts 的 AST 编辑
    github.ts          GitHub REST + GraphQL
    access.ts          Access JWT 验签
    cache.ts           KV 读缓存
    diff.ts            行级 diff

src/web/               Preact 面板
  views/              每个分区一个视图
  components/         对话框、反馈、底部栏、diff
  lib/                路由、API 客户端、Markdown 渲染、指令解析
  styles/             基础、视图、手机端

migrations/            D1 表结构
```

---

## 性能

每个屏幕都有 KV 读缓存，写入时精确失效。首屏之后，Worker 会并行把其余屏幕的缓存预热好（`POST /sites/:id/warm`），所以点标签时数据已经在了。客户端另有一层 15 秒的内存缓存，写入时清空。

八个标签页的打开耗时都在 60ms 以内。

---

## 已知限制

- **拿不到 run 的完整日志原文**。GitHub 的日志接口返回 zip，Worker 不解压。面板给步骤级状态、失败步骤名和日志直链。
- **只有 `covers`、`music`、`og` 会提交**。`build`、`test:*` 不产生提交。
- **Mermaid 预览与站点构建输出不完全一致**。构建期是 rehype 插件，面板是运行时库。
- **不做实时协同**。并发编辑靠 `sha` 兜底，冲突时提示刷新。
- **单个 PAT 覆盖它授权范围内的所有仓库**。多站点建议为每个站点配独立令牌。
- **预览不是像素级还原**。它渲染的是同一份 Markdown，但用的是面板的 CSS，不是站点的。

---

## 许可

MIT
