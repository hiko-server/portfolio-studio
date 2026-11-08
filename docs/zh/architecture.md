# 架构：存储、迁移、请求路径、路由、目录与测试

属于 [Portfolio Studio](../../README.zh.md) · 返回[架构](../../README.zh.md#架构) · 英文版：[docs/architecture.md](../architecture.md)

本页面向改动代码的人：一个请求如何流转，内容存在哪里、如何写入，五个 SQLite 库如何迁移，每条公开路由及其背后的处理器，目录结构与测试套件。每一条说明都注明了对应的文件。

## 内容存储（本地优先）

```text
                ┌─────────────┐
   后台 GUI  ──▶│ /api/home   │──┐
                │ /api/admin/*│  │ 双写
                └─────────────┘  │
                                 ▼
            ┌──────────────────────────────┐
            │ SQLite (data/content.db)     │  ← 真源
            └──────────────────────────────┘
                                 │ 尽力而为
                                 ▼
            ┌──────────────────────────────┐
            │ Cloudflare R2                │  ← 异地镜像
            │ pages/*.mdx, blog/, work/,   │
            │ data/*.json, uploads/,       │
            │ backups/snapshot-<UTC>.tgz   │
            └──────────────────────────────┘
```

`lib/contentStore.ts` 是双写存储；`lib/db.ts` 打开 `data/content.db`（表 `pages`、`collection_items`、`kv`、`r2_pending`，以及迁移 002 与 003 加入的编辑与媒体表）；`lib/r2.ts` 负责与镜像通信。

- **读取顺序**：先查 SQLite；缺失的行用 git 种子补上（`data/home.json`、`data/cvdata.json`；仓库里的 `content/blog/` 与 `content/work/` 只有 `.gitkeep`），并把种子写入存储。种子从不覆盖：存在但无法解析的行会被报告，对读取方视为不存在，绝不会被过时的种子替换。
- **写入顺序**：同步的 SQLite 写入必须成功（错误会向上抛出；多条语句的写入在一个事务里完成）。配置了 R2 时随后推送到 R2，带退避重试（`lib/r2.ts` 中的 `R2_TIMEOUTS`：连接 5 s、每次请求 10 s、3 次尝试）；仍然失败时本地写入照旧生效，调用方得到 `r2Warning`，该键记入 `r2_pending`，下次启动时按本地行重新上传或删除，而不是信任时间戳。
- **R2 键的布局**与文件树一致，任何 S3 浏览器都能查看：`pages/*.mdx`、`blog/*.mdx`、`work/*.mdx`、`data/*.json`、`uploads/*`、`backups/*.tgz`。
- **容器启动**在服务器启动前运行 `scripts/sync-from-r2.mjs`：先处理待同步的键，再按真实时间戳（R2 的 `LastModified` 对比行的 `updated_at`）取较新的一方。退出码 0 表示已同步或未配置 R2；3 表示 R2 失败但本地内容完整，站点照常提供；1 表示没有可提供的内容（或设置了 `R2_REQUIRED=1` 却没有 R2），容器拒绝启动一个空站点（`docker-entrypoint.sh`）。

`data/` 下有五个库：`content.db`、`analytics.db`（访问记录、Web Vitals、目标事件、错误、恢复演练结果）、`auth.db`（会话、通行密钥、审阅链接、CV 分享链接、AI 设置、令牌与授权）、`audit.db`（操作日志）与 `ai.db`（对话、改动、调用日志）。后三个保持 0600 权限（`scripts/migrate-db.mjs`）。`data/content.db` 是真源；git 种子是单向的引导数据；R2 是启动时对账的镜像。每个部署一个管理员账号（`lib/admin.ts`）；没有多租户。

## SQLite 版本化迁移

每个库（`content.db`、`analytics.db`、`auth.db`、`audit.db`、`ai.db`）在 `scripts/db/<store>/NNN-name.mjs`（`<store>` 为库名）有一组有序的迁移模块，由 `scripts/db/<store>/index.mjs` 列出、`scripts/db/migrate.mjs` 执行，应用与纯 Node 的启动脚本共用这套代码。目前：content 3 个（`001-baseline`、`002-editorial`、`003-media-library`），analytics 7 个（`001-baseline` 到 `007-explore`），auth 5 个（`001-passkeys-sessions` 到 `005-ai-access`），audit 2 个（`001-baseline`、`002-ai-actor`），ai 2 个（`001-baseline`、`002-change-issuer-session`）。

一个迁移是 `{ version, name, up(db) }`；版本号从 1 起且连续。每个迁移连同它在 `schema_version`（同步到 `PRAGMA user_version`）中的记录在自己的 `BEGIN IMMEDIATE` 事务里完成，要么全部生效要么完全不生效，即使多个进程同时打开同一个库（`next build` 的 worker、启动同步与服务器）也只执行一次。每个库的版本 1 都是用 `CREATE ... IF NOT EXISTS` 写成的基线，因此早于迁移器的库可以原样纳入，表结构不变。

迁移在库打开时与服务器启动时（`instrumentation.ts`）执行；已版本化的库在新步骤触碰它之前，会先用 `VACUUM INTO` 复制到 `data/backups/pre-migration/`（保留最新 5 份）。只允许增量变更——新增表、可空或带默认值的列、索引；在停止使用某项的那个版本里绝不删除、重命名或改类型——因为 `scripts/deploy.sh` 的回滚方式是在同一个数据卷上启动上一个镜像，旧镜像遇到新库时只记一条警告并继续运行。`yarn db:status` 显示各库版本；运维手册见 [docs/zh/operations.md → 迁移](operations.md#迁移)。

## 请求路径与 ISR

`proxy.ts` 是 Next 16 的 proxy（原 middleware）；它在服务器进程里的 Node.js 运行时上、先于任何页面或 API 路由运行，承担五项职责：跳转（已配置的公开域名上的明文 HTTP 以 308 跳到 https，访客使用的协议先取 `cf-visitor` 再取 `x-forwarded-proto`，`/api/health` 除外；旧地址 `/cv?lang=zh|cn` 跳到 `/cv/zh`；去掉尾斜杠），每个响应的安全头（`lib/security/responseHeaders.ts`，CSP 来自 `lib/csp.js`），`/api/admin/*`、`/api/auth/*`、`/api/cvdata`、`/api/home`、`/api/versions` 与 `/api/mongo` 上不安全方法的 CSRF 防护（跨站 403；表单编码、multipart 与纯文本正文 415；`lib/security/csrf.ts`），`/admin/*` 与 `/api/admin/*` 的后台鉴权门（页面跳转到登录页，API 返回 JSON 401；`lib/adminAuth/proxyGate.ts`），以及只在 AI access 与已连接应用都开启时才存在的 AI 公开路径（`lib/aiPublicRoutes.js`、`lib/ai/settings.ts`）。IndexNow 密钥文件 `/<INDEXNOW_KEY>.txt` 被改写到 `/api/indexnow-key`。

API 路由由 `withApi`（`lib/apiHandler.ts`）包装：带请求 ID 的日志、错误捕获，以及 `lib/audit/describe.ts` 列出的每条路由的操作日志记录。

ISR（Incremental Static Regeneration，增量静态再生成）时间：`/` 与 `/about` 每 3600 s（`PROFILE_REVALIDATE_SECONDS`，`lib/isr.ts`），`/cv` 与 `/cv/zh` 60 s（`lib/cvPage.ts`），`/contact` 300 s（`lib/contactPage.ts`），文章、案例、`/now`、`/uses` 与 `/publications` 60 s，`/colophon` 为静态页。构建时的渲染只给 1 s 窗口（`BUILD_REVALIDATE_SECONDS`），因为镜像构建时没有数据库。每次保存后，`lib/revalidate.ts` 按需重新生成受影响的路径（简历与首页路径还会再确认一遍），删除已变成 404 的页面的持久化副本（`lib/isrPages.ts`、`lib/isrCache.ts`），把搜索索引标记为过期，并以 3 s 超时触发边缘缓存清除与 IndexNow，绝不会让保存失败。HTML 在边缘最多保留 5 分钟（`Cloudflare-CDN-Cache-Control`，`lib/edgeHtmlTtl.ts`），并带 `Cache-Control: no-transform` 发送（`lib/htmlNoTransform.ts`）。

## 目录结构

```text
.
├── assets/              # 字体源文件（fonts/）与 PDF 字体子集（pdf/）
├── components/          # UI：LandingPage/、Admin/、Search/、Chrome/、General-UI/ 等
│   ├── Admin/           # HomeEditor、CVEditorStudio、StoragePanel、RichEditor、shell/
│   │   └── ai/          # 后台 → AI：助手、改动、连接、模型、在编辑器里问 AI
│   └── LandingPage/     # PersonalInfo、Content、ExperienceTimeline 等
├── content/             # MDX 种子目录（blog/、work/）；仓库里只有 .gitkeep
├── data/                # 运行时状态，除两份示例种子外均已 .gitignore
│   ├── content.db       # SQLite 真源
│   ├── analytics.db, auth.db, audit.db, ai.db
│   ├── home.json        # 纳入版本库的示例种子：Hero / 社交 / 品牌 / 照片
│   ├── cvdata.json      # 纳入版本库的示例 CV 种子（en / zh，虚构内容）
│   ├── admin.json       # 本地管理员记录（hash + salt），从不进入快照
│   ├── snapshots/       # 每类内容的版本历史
│   └── backups/         # snapshot-<UTC>.tgz 与 pre-migration/ 副本
├── docs/                # 本手册、docs/ai-trial.md、docs/screenshots/
├── e2e/                 # Playwright + axe 测试；fixtures/store 是合成数据存储
├── lib/                 # 服务端工具库
│   ├── contentStore.ts / db.ts / r2.ts     # 存储及其镜像
│   ├── backup.ts / backupSchedule.ts / restoreDrill.ts
│   ├── admin.ts / auth.ts / adminAuth/     # scrypt、会话、通行密钥、二次验证
│   ├── homeShape.ts / homeSections.ts      # HomeData schema 与板块键
│   ├── currentlyCoding.ts                  # 从 CV 推导的芯片
│   ├── env.ts / rateLimit.ts / mailer.ts
│   ├── security/        # csrf、safeFetch、loginThrottle、proxyTrust 等
│   ├── analytics/ errors/ audit/ inbox.ts
│   ├── ai/              # 工具、计划、批准、服务商、agent 循环、OAuth
│   └── mcp/             # MCP 服务器（server.ts，只由 pages/api/mcp.ts 接线）及其 HTTP 辅助函数（http.ts，与 lib/ai 共用）
├── pages/
│   ├── api/             # 全部服务端接口
│   │   ├── admin/       # 需鉴权：storage、posts、work、page、ai/、orcid/、security/ 等
│   │   ├── auth/        # email-login、passkey/、request-reset、reset-password
│   │   ├── oauth/       # authorize、token、register、revoke、metadata、open
│   │   └── mcp.ts, home.ts, cvdata.ts, mongo.ts, og.tsx, health.ts 等
│   ├── admin/           # 需鉴权 UI：dashboard、login、ai、system、security 等
│   ├── zh/              # 中文页面
│   └── index.tsx, about/, blog/, work/, cv/, now.tsx, uses.tsx, colophon.tsx 等
├── scripts/             # CLI：deploy.sh、migrate-db、sync-*-r2、perf-budget、check-*、ai-*
│   ├── db/              # 每个库的版本化迁移
│   └── ci/              # fixture-store.mjs、fixture-images.mjs
├── security/            # audit-allowlist.json（已审阅、带到期日的豁免）
├── styles/ theme/       # globals.css；设计令牌与 Chakra 主题
├── tests/               # node:test 单元测试、register.mjs、no-network.mjs
├── proxy.ts             # 跳转、安全响应头、CSRF、后台鉴权门（Node.js）
├── instrumentation.ts   # 启动：迁移、定时任务、错误捕获
├── docker-entrypoint.sh # R2 对账、静态资源归档、ISR 预热、服务器
├── Dockerfile           # 两阶段 node:22-alpine 构建
└── public/              # 静态资源；uploads/ 是运行时状态
```

## 公开路由

| 路由 | 说明 |
|---|---|
| `/` | 首页——Hero、亮点（Highlights），以及按站长顺序排列的各板块（ISR，每小时及保存时更新） |
| `/about` | 身份栏、站长自述与全部展开的双语简历（ISR，每小时及保存时更新） |
| `/cv` | 英文简历（ISR，每分钟及保存时更新）：A4 页面 / 阅读视图、技能出处、下载；`?print=1` 打开打印对话框（每个「Download PDF」链接都指向 `/cv.pdf` / `/cv/zh.pdf`） |
| `/cv/zh` | 同一份简历的中文版（`/cv?lang=zh` 跳转至此） |
| `/cv.pdf`、`/cv/zh.pdf` | 服务端渲染的 A4 PDF（带标签、内嵌字体），文件名带日期，有 ETag |
| `/cv.txt`、`/cv/zh.txt` | 纯文本简历，方便粘贴进申请表单 |
| `/cv.json`、`/cv/zh.json` | 公开简历的 JSON Resume 1.0.0 |
| `/cv/r/<token>`、`/cv/r/<token>/en.pdf`、`/cv/r/<token>/zh.pdf` | 带签名、会过期、可撤销的私密链接后的定制简历版本（`noindex`、`no-store`、`no-referrer`）及其 PDF |
| `/publications` | 简历论文板块的公开页面：引用、链接、摘要、复制 BibTeX / APA、ScholarlyArticle JSON-LD（没有公开论文时返回 404） |
| `/work` | 案例索引（MDX） |
| `/work/[slug]` | 单篇案例（封面 + 正文） |
| `/blog` | 博客索引 + 标签筛选 + 订阅源链接 |
| `/blog/[slug]` | 单篇文章：语法高亮、目录、可放大的图片 |
| `/now` | 「最近在做什么」页面（MDX） |
| `/uses` | 工具、硬件、服务清单（MDX） |
| `/contact` | 联系页（ISR）：带隐私说明的结构化表单、可用状态、复制按钮、vCard + 二维码 |
| `/colophon` | 本站如何构建、隐私说明、更新日志、部署的提交 |
| `/zh`、`/zh/about`、`/zh/blog`、`/zh/work`、`/zh/contact` | 中文页面；每一页只在站长写了对应中文内容时才存在（`lib/zhSite.ts`、`lib/zhRoutes.ts`） |
| `/feed.xml`、`/work/feed.xml`、`/feed.json` | 全文 RSS（文章、案例）与 JSON Feed |
| `/sitemap.xml` | 站点地图，简历及已互译的文章、案例带 EN / 中 互链 |
| `/llms.txt`、`/llms-full.txt` | 面向语言模型与智能体的索引（llmstxt.org），以及全部已发布文章与案例的 Markdown 全文 |
| `/blog/[slug].md`、`/work/[slug].md` | 已发布文章或案例的 Markdown 版本（规范链接指向网页，`noindex`） |
| `/review/<token>` | 审阅链接：以只读方式显示一篇草稿（或待发布修改），带「Preview」水印；私密、`no-store`、`noindex`、`no-referrer`；过期或关闭后返回 410 |
| `/api/search-index` | 供命令面板使用的公开搜索文档（中英文）与提问（Ask）模式的原文段落 |
| `/api/vcard` | 公开联系方式的 vCard |
| `/api/health` | 健康状态：所有人只看到 `{"status":"ok"\|"empty"\|"degraded"}`；存储、内容、备份时长、恢复演练、未处理的错误与待同步的 R2 写入仅对管理员或携带 `Authorization: Bearer <HEALTH_TOKEN>` 的请求返回 |
| `/api/og` | 社交卡片：固定页面用 `?card=<id>`，文章用 HMAC 签名的参数；其他请求得到默认卡片 |
| `/.well-known/security.txt` | RFC 9116 安全联系方式（公开简历中的邮箱，有效期滚动 180 天；邮箱隐藏时返回 404） |
| `/mcp` | MCP 服务器（仅 POST、仅 `Authorization: Bearer`、`no-store`、`noindex`）；只有在 AI access 与「Allow connected apps」都开启且设置了 `SITE_URL` 时才存在——否则它与下面几行的响应都与不存在的路径完全相同 |
| `/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server` | OAuth 发现文档（`public, max-age=300`） |
| `/oauth/authorize`、`/oauth/token`、`/oauth/register`、`/oauth/revoke` | 供已连接应用使用的 OAuth 2.1 授权服务器；authorize 只是跳转到同意页的同站中转，不存储也不抓取任何东西 |
| `/ai/review/<id>` | 应用给出的改动审阅链接：同站跳转到 `/admin/ai/change/<id>`（不含数据；其他格式的 id 返回 404） |

`/cv.*`、`/cv/zh.*`、`/cv/r/<token>/*.pdf`、`/blog/<slug>.md`、`/work/<slug>.md`、`/.well-known/security.txt` 与 `/uploads/*` 背后的 rewrite 在 `next.config.js` 中；AI 相关的来自 `lib/aiPublicRoutes.js`。API 位于 `/api/*`；`/api/admin/*` 下的管理接口由代理（`proxy.ts`）把关。后台页面列于 [docs/zh/admin.md → 后台页面](admin.md#后台页面)。

## 测试套件

单元测试是 `node:test` 下的 `tests/*.test.ts`（`yarn test`；`yarn run check` 则把 `tsc --noEmit`、零警告的 ESLint 与整套测试一起跑）。`tests/register.mjs` 解析不带扩展名的 `.ts` 导入并安装 `tests/no-network.mjs`，后者拒绝任何离开本机的连接或 DNS 查询，并让发起它的测试文件失败；整套测试不需要 `.env`。辅助代码在 `tests/helpers/`（`fake-llm.mjs` 是脚本化的模型服务商），ORCID 测试数据在 `tests/fixtures/`，`tests/mcp-conformance-baseline.yml` 是 MCP 一致性测试经审阅的基线。

端到端测试（`e2e/`，`yarn e2e`，`e2e/playwright.config.ts`）针对 `E2E_BASE_URL` 运行（默认 `http://127.0.0.1:3000`；本地 `yarn start` 监听 `http://127.0.0.1:3002`）。它的项目：`chromium`（桌面，不含 `@admin` 与视觉测试），只跑公开用例的 `tablet`（768 × 1024）、`mobile`（Pixel 7）与 `reduced`（减少动效），跑跨引擎用例集的 `webkit`（iPhone 15）与 `firefox`，`visual`（`e2e/visual.spec.ts` 及其基线），以及 `admin`（`@admin`，单 worker，在其他全部项目之后）。`ai-admin`（Chromium）与 `ai-consent-firefox` 两个项目只在设置了 `E2E_FAKE_LLM_URL` 时注册——`scripts/ai-e2e.sh` 会设置它；此时配置会拒绝任何不在 `127.0.0.1` 上的基础地址，因此 `yarn e2e` 与部署后的运行永远不会列出它们。

公开用例在桌面、平板、手机与减少动效四种配置下检查每个公开页面：恰好一个可见的 `h1`、`lang`（`/cv/zh` 为 `zh-Hans`）、标题与描述、无严重 / 关键级 axe 问题（WCAG 2.0 至 2.2 A/AA）、无横向滚动、手机上 24 × 24 px 的点击目标（正文内联链接除外）、减少动效时没有正在播放的动画、主题持久化、⌘K 命令面板与旧地址跳转——任何控制台错误、未捕获异常或 CSP 违规都会使测试失败。`@admin` 用例从环境变量 `ADMIN_EMAIL` / `ADMIN_PASS` 读取登录信息（`yarn e2e` 不读 `.env`），缺少时跳过；它们会修改内容（端到端地隐藏并恢复一个 CV 字段、在两个编辑器之间制造「Changed elsewhere」冲突、打开快捷键面板、跟踪一条联系留言进入收件箱），因此除一次性的数据存储外，请用 `--grep-invert @admin` 排除它们。`e2e/fixtures/store` 下的合成数据存储（*Example Person*、程序生成的图片）是 `scripts/check-fixture-gates.sh` 与 `scripts/ai-e2e.sh` 使用的数据；完整的关卡清单见 [docs/zh/operations.md → 质量关卡](operations.md#质量关卡)。
