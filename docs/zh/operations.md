# 运行它：环境变量、存储、备份、健康、脚本与关卡

属于 [Portfolio Studio](../../README.zh.md) · 返回[快速开始](../../README.zh.md#快速开始) · 英文版：[docs/operations.md](../operations.md)

本页面向运行一个部署的人：每个环境变量及其默认值，五个 SQLite 库及其迁移，带恢复路径与恢复演练的备份流水线，错误监控、系统健康与操作日志，各项后台安全控制的说明所在，CLI 脚本，以及完整的质量关卡。Docker、部署脚本与 Cloudflare 在 [docs/zh/deployment.md](deployment.md)。

## 环境变量

所有变量都写在 [`.env.example`](../../.env.example) 里；仓库从不提交真实的 `.env`（它被 gitignore 与 dockerignore 排除，也不进入任何快照）。重点：

| 分组 | 变量 | 是否必填 |
|---|---|---|
| 管理员引导 | `ADMIN_EMAIL`（或 `ADMIN_USER`）、`ADMIN_PASS` | 首次启动必填：`data/admin.json` 只在缺失时由它们创建（`lib/admin.ts`）；改密码后请删除 `ADMIN_PASS` |
| 会话 | `JWT_SECRET`（`openssl rand -base64 32`；至少 32 个随机字符） | 始终必填；也是 `/api/og` 签名密钥与 MCP 令牌标记密钥的根 |
| 站点身份 | `NEXT_PUBLIC_PRODUCT_NAME`、`NEXT_PUBLIC_SITE_HOST`（构建时）、`SITE_URL` | 推荐；`/mcp` 与 OAuth 需要 `SITE_URL` |
| 默认主题 | `NEXT_PUBLIC_DEFAULT_THEME`（留空为 `dark`，可选 `light` 或 `system`；构建时生效） | 可选 |
| 部署的提交 | `NEXT_PUBLIC_BUILD_SHA`（构建参数；`scripts/deploy.sh` 导出它；显示在 `/colophon`） | 可选 |
| 客户端 IP | `TRUST_CLIENT_IP_HEADER`（默认 `cf-connecting-ip`；可选 `x-real-ip`、`x-forwarded-for` 或 `none`）、`TRUSTED_PROXY_IPS`（可为其担保的 IP 或 CIDR；留空 = 回环地址加容器默认网关） | 可选——见 [SECURITY.md → Client IP](../../SECURITY.md#client-ip-libratelimitts-libsecurityipts-libsecurityproxytrustts)（英文） |
| 邮件 | `SMTP_HOST`、`SMTP_PORT`（587）、`SMTP_USER`、`SMTP_PASS`、`FROM_EMAIL`、`NOTIFY_EMAIL`、`REPLY_FROM_EMAIL`（收件箱回复的发件地址；默认为 SMTP 账号本身） | 可选——未设置时跳过发送（`lib/mailer.ts`） |
| 联系验证码 | 无——内置 nonce + 算术题 + 蜜罐 | 不适用 |
| GitHub | `GITHUB_TOKEN`（细粒度令牌，仅公开仓库只读，不授予任何权限） | 推荐（API 限额从每小时 60 次提高到 5000 次） |
| MongoDB 备份 | `MONGODB_URI`、`MONGODB_DB_NAME` | 可选；来自环境变量的 URI 会让 `/admin/db-config` 变为只读 |
| Cloudflare R2 | `R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_REQUIRED`（`1` 时没有 R2 就拒绝启动） | 可选 |
| 定时备份 | `BACKUP_INTERVAL_HOURS`（默认 24，`0` 关闭） | 可选 |
| 恢复演练 | `RESTORE_DRILL_INTERVAL_HOURS`（默认 168，`0` 关闭） | 可选 |
| 留言保存期限 | `CONTACT_RETENTION_DAYS`（默认 365，`0` 表示保留到手动删除） | 可选 |
| 链接检查 | `LINK_CHECK_INTERVAL_HOURS`（默认 24，`0` 关闭定时检查） | 可选 |
| 日志 | `LOG_LEVEL`（`debug` / `info` / `warn` / `error`；生产环境为 JSON 行） | 可选 |
| Cloudflare 缓存清除 | `CF_ZONE_ID`、`CF_API_TOKEN`（Cache Purge 权限） | 可选——两者都设置才会发送 |
| IndexNow | `INDEXNOW_KEY`（8–128 位 `[A-Za-z0-9-]`） | 可选——未设置即关闭 |
| 健康详情 | `HEALTH_TOKEN`（供监控使用的 Bearer 令牌） | 可选——未设置时只有已登录的管理员能看到 `/api/health` 详情 |
| 后台二次验证 | `ADMIN_RECENT_AUTH_MINUTES`（1–60，默认 10） | 可选 |
| 早先构建的静态资源 | `STATIC_ARCHIVE_DAYS`（天数，1–90，默认 7） | 可选 |
| 图片编码 | `IMAGE_JOB_CONCURRENCY`（同时编码的图片数，1–4，默认 1）、`IMAGE_JOB_QUEUE_MAX`（可排队等待的上传数，0–64，默认 8；超出则返回 503「忙碌」）、`SHARP_CONCURRENCY`（每张图片的 libvips 线程数，1–4，默认取 CPU 数，最多 2） | 可选——默认值让并发上传不超出 1 GiB 的容器内存 |
| ORCID 连接 | `ORCID_CLIENT_ID`、`ORCID_CLIENT_SECRET`、`ORCID_ENV`（默认 `production`，或 `sandbox`） | 可选——未设置时「Connect your ORCID iD」保持禁用（[配置方法](authoring.md#连接-orcid-id)） |
| AI（[说明](ai.md)） | `AI_KEYS_SECRET`（32 个随机字节的 base64：`openssl rand -base64 32`；用于加密模型密钥，从不由 `JWT_SECRET` 派生）、`AI_DISABLED`（`1` 关闭所有 AI 路径）、`AI_LOCAL_PROVIDER_ORIGINS`（精确的回环地址源，如 `http://127.0.0.1:11434`，仅当 `SITE_URL` 为回环地址时生效） | 可选——在后台 → AI 开启前 AI 一直关闭；公开的 MCP 与 OAuth 地址还需要 `SITE_URL` |

代码会读取但未列在 `.env.example` 中的变量：`PORT`（`yarn start` 默认 3002；Dockerfile 设为 3000）、`HOSTNAME`（镜像设置它，让服务器监听容器的所有网卡）、`NEXT_TELEMETRY_DISABLED=1`（镜像）、`E2E_BASE_URL` 与 `E2E_FAKE_LLM_URL`（Playwright 配置）、`MCP_CONFORMANCE_TOKEN`（`scripts/mcp-conformance.sh`）、`AI_SMOKE_KEY_<PRESET>`（`scripts/ai-live-smoke.mjs`）、`STATIC_ARCHIVE_DIR`（`scripts/static-archive.mjs`）、`WARM_HEALTH_TIMEOUT_MS`（`scripts/warm-isr.mjs`）。`NEXT_PUBLIC_*` 的值必须作为 Docker 构建参数传入；`docker-compose.yml` 会从 `.env` 转发它们。

## 迁移

`yarn db:status` 打印每个库的 schema 版本与待执行的迁移，不写入任何内容；`yarn db:migrate` 对 `./data` 下存在的库执行待迁移（应用在库打开时与服务器启动时也会这样做，所以这条命令用于部署前查看，或迁移一份副本：`node scripts/migrate-db.mjs --db content --file /tmp/copy.db`）。在容器内：`docker compose exec landing-page node scripts/migrate-db.mjs --status`。退出码：0 正常，1 某个迁移失败，2 参数错误。新步骤触碰已版本化的库之前，会先用 `VACUUM INTO` 复制到 `data/backups/pre-migration/`（保留最新 5 份）；`auth.db`、`audit.db` 与 `ai.db` 保持 0600 权限。模型（只增不减、每步一个事务、跨进程只执行一次）见 [docs/zh/architecture.md → SQLite 版本化迁移](architecture.md#sqlite-版本化迁移)。

## 备份流水线

全站快照由 `lib/backup.ts` 打包。一份快照只包含内容：

```text
MANIFEST.json
db/content.db                     ← 经 SQLite Online Backup API（WAL 一致）
data/snapshots/<dir>/**           ← cv / home / blog / work / page 的版本历史
uploads/*                         ← public/uploads
data/inbox/contact-inbox.jsonl    ← 联系留言（恢复时合并，从不替换）
```

`MANIFEST.json` 记录每个文件的大小与 SHA-256、行数以及 `db/content.db` 的 schema 版本。`data/admin.json` 与 `data/mongo_config.json` 从不写入快照，旧快照仍带着它们时恢复会忽略（`NEVER_RESTORED`）：恢复内容绝不能回滚管理员密码。同样不在快照里的：`.env`、`auth.db`（会话、通行密钥、审阅与分享链接、AI 设置与令牌）、`audit.db`、`ai.db` 与 `analytics.db`。部署脚本的每次部署备份——全部五个库的在线副本、`data/` 的 tar 包与一份 `.env`——覆盖的正是这些；用其他方式部署时，请保留它或自己的等价方案。

流水线：`tar pack → gzip → fs.WriteStream → 原子 rename`（快照先写入临时文件，tar 收尾后才改名就位）。本地副本写到 `data/backups/snapshot-<UTC>.tgz`，并推到 R2 的 `backups/<UTC>.tgz` 与 `backups/latest.tgz`（低成本的拉取目标）。保留策略：本地最新 20 份（`LOCAL_KEEP`），R2 最新 30 份（`R2_KEEP`）；超过 `CONTACT_RETENTION_DAYS` 的快照也会清理，最新一份始终保留。`lib/backupSchedule.ts` 每隔 `BACKUP_INTERVAL_HOURS`（默认 24）在内容有变化时生成快照；备份时长显示在存储标签页与 `/api/health` 的详情中。

**恢复。** 后台 → 存储（Storage，`/admin/dashboard?tab=storage`）：「立即备份（Backup now）」打包一份快照（`pages/api/admin/storage/backup.ts`）；「拉取最新（Pull latest）」打开恢复对话框，其按钮为「拉取并恢复（Pull and restore）」（`pages/api/admin/storage/pull.ts`）：它获取 R2 的 `backups/latest.tgz`（默认；未配置 R2 时返回 503）或按文件名指定的本地 tarball，先把被替换的状态作为安全快照写入 `data/backups`，再解压到同级临时目录、关闭活跃的数据库句柄、替换文件，并把上传目录与版本历史树镜像回活跃树；之后每条内容行重新镜像到 R2，每个渲染存储内容的公开页面重新生成。站长若未在 `ADMIN_RECENT_AUTH_MINUTES`（默认 10）分钟内登录或重新验证，它返回 `403 STEP_UP_REQUIRED`；另一个备份或恢复正在进行时返回 409。配有 R2 凭据的新主机无需手动恢复：`scripts/sync-from-r2.mjs` 在启动时从镜像重建存储（[docs/zh/deployment.md → Docker](deployment.md#docker)）。可选的 MongoDB GridFS 备份 / 恢复目标在 `/admin/db-config` 配置（`pages/api/mongo.ts`）。

**恢复演练**（`lib/restoreDrill.ts`）：每隔 `RESTORE_DRILL_INTERVAL_HOURS`（默认 168，即每周）把最新备份——配置了 R2 时用 `backups/latest.tgz`，否则用本地最新快照——解到临时目录检查：归档与清单、每个文件的大小与 SHA-256、`PRAGMA integrity_check`、本版本的迁移、与清单比对行数、渲染最新一篇已发布文章。不触碰线上站点；结果与「立即演练（Run drill now）」按钮在后台 → 系统健康（System health），失败或过期的演练会出现在 `/api/health` 的警告中。

<img src="../../docs/screenshots/admin-storage.png" width="900" alt="存储标签页：快照计划、「立即备份」与「拉取最新」按钮、标为真源的本地 SQLite、R2 状态">

## 错误监控与系统健康

完全自建，数据不离开服务器：浏览器未捕获的错误、未处理的 Promise 拒绝与错误边界捕获（上报脚本只在出错时才加载）、CSP 违规与 Trusted Types 报告（`report-to` / `report-uri` → `/api/e`；仅报告模式的 Trusted Types 分组按每组每天最多 50 条抽样，只保留接收点名称、不存样本文本），以及服务端错误（API 路由、页面渲染、代理、任何记录下来的异常）按指纹归组存入 `data/analytics.db`——去除查询字符串、邮箱 / IP、令牌和类 ID 数字，不存地址、User-Agent 或 Cookie——在后台 → 系统 → 错误（`/admin/system?view=errors`）中处理：解决、忽略、重开；已解决的错误再次出现会自动重开；未处理的错误保留 90 天（`lib/errors/store.ts`）。后台 → 系统 → 健康（`/admin/system`，`lib/systemHealth.ts`）显示部署版本、运行时长、内存、磁盘余量、各数据库的大小 / WAL / schema 版本、备份、恢复演练与近期的 warn / error 日志。`/api/health` 对所有人返回 `{"status":"ok"|"empty"|"degraded"}`，详情（存储、内容、备份时长、恢复演练、未处理的错误、待同步的 R2 写入）只返回给管理员或携带 `Authorization: Bearer <HEALTH_TOKEN>` 的请求。

**操作日志**（后台 → 系统 → 操作日志，`/admin/system?view=activity`）：记录每次成功的后台写入——保存、发布、恢复、删除、收件箱操作与回复、上传、备份、安全设置、每次 AI 写入——谁（已登录的浏览器：粗略的设备类型、网段、国家，从不存完整地址；或 AI 执行者）、做了什么、何时，并与登录记录里的登录和密码重置合并显示。它存放在独立的 `data/audit.db`（`scripts/db/audit` 中的版本化迁移；保留 400 天 / 20 000 条，`lib/audit/store.ts`），部署时会在线备份，不进入内容快照，所以恢复内容不会改写它。`lib/audit/describe.ts` 列出的路由由 `withApi` 自动记录；只有在运行时才知道操作内容的路由，在写入成功后调用 `recordAdminAudit(req, res, { action, area, target, summary })`（`lib/audit/record.ts`）；既不在列表里也不调用它的写入路由会让单元测试失败。版本历史会说明每个版本是被哪次改动替换的，差异精确到词（中文用 `Intl.Segmenter` 分词）。

日志在生产环境为带请求 ID 与密钥脱敏的结构化 JSON 行（`lib/log.ts`，`LOG_LEVEL`）；容器会轮转日志（`local` 驱动，5 × 10 MB）。

## 后台安全：各项控制所在位置

每项控制的权威说明是 [SECURITY.md → Security posture](../../SECURITY.md#security-posture)（英文）；本列表只说明去哪里看。

- 代理鉴权门、会话 Cookie `cv_admin_token`（HS256 JWT，7 天，按会话版本与 `auth.db` 中每个浏览器一行的会话记录吊销；`httpOnly`、`SameSite=Strict`、生产环境 `Secure`、`path: /`）、「Sign out everywhere」、登录记录（列出最近 40 条）→ [Authentication and sessions](../../SECURITY.md#authentication-and-sessions)；代码 `proxy.ts`、`lib/adminAuth/proxyGate.ts`、`lib/auth.ts`、`lib/adminAuth/sessions.ts`。
- scrypt 密码哈希（N=16384、r=8、p=1、64 字节 key、16 字节盐）、修改密码及其规则（NFKC 规范化后 12 至 256 个字符、常见密码检查）、邮件重置令牌（24 字节随机、30 分钟、一次性）→ 同一节；代码 `lib/admin.ts`、`lib/adminAuth/passwordPolicy.ts`。
- 通行密钥（WebAuthn）、十个一次性恢复码、「Require a passkey」→ 同一节；代码 `lib/adminAuth/passkeys.ts`、`pages/api/admin/security/`。
- 危险操作前、`ADMIN_RECENT_AUTH_MINUTES`（默认 10）分钟内的二次验证 → 同一节；代码 `lib/adminAuth/stepUp.ts`。
- 登录限速：按（邮箱，IP）退避、全局减速、从不全局锁定；登录成功会写入签名的「已知设备」Cookie，持有它的浏览器可绕过全局队列 → [Login brute-force defence](../../SECURITY.md#login-brute-force-defence-libsecurityloginthrottlets-libsecuritylogingatets)；代码 `lib/security/loginThrottle.ts`、`lib/security/loginGate.ts`。
- 客户端 IP 与限流：只信任来自 `TRUSTED_PROXY_IPS` 的 `TRUST_CLIENT_IP_HEADER`，IPv6 按 /64 归并（登录按 /48），进程内限流器重启即清零 → [Client IP](../../SECURITY.md#client-ip-libratelimitts-libsecurityipts-libsecurityproxytrustts)；代码 `lib/rateLimit.ts`、`lib/security/proxyTrust.ts`、`lib/security/rateLimitCore.ts`。
- CSRF：跨站 403、表单正文 415，叠加在 `SameSite=Strict` 之上 → [CSRF](../../SECURITY.md#csrf-proxyts-libsecuritycsrfts)；代码 `lib/security/csrf.ts`、`proxy.ts`。
- 上传：文件名白名单、上传时经 sharp 处理、没有按请求的优化器（`/_next/image` 返回 404）→ [Uploads](../../SECURITY.md#uploads)；代码 `lib/security/uploadName.ts`、`lib/imageVariants.ts`。
- 生产环境基于哈希、不含 `'unsafe-eval'` 的 CSP，Trusted Types 仅报告模式，HSTS，COOP / CORP，Permissions-Policy，后台页面的 `X-Robots-Tag` 与 `no-store` → [HTTP headers](../../SECURITY.md#http-headers-proxyts-libcspjs-libsecurityheadersjs)；代码 `lib/csp.js`、`lib/security/responseHeaders.ts`、`lib/security/inlineScripts.ts`。
- SSRF：服务端抓取任何来自内容或后台的 URL 都经过 `lib/security/safeFetch.ts`（只允许公网地址，限制大小、跳转次数与时长）。
- 容器加固 → [Container runtime](../../SECURITY.md#container-runtime-dockerfile-docker-composeyml)；备份 → [Backups and restore drills](../../SECURITY.md#backups-and-restore-drills)；AI → [AI access](../../SECURITY.md#ai-access)。

## CLI 脚本

```bash
yarn content:migrate    # 从 content/*.mdx 与 data/*.json 为 data/content.db 补种（幂等；--force 覆盖）
yarn content:pull       # R2 → SQLite（覆盖；读 .env）
yarn content:push       # SQLite → R2（覆盖；读 .env）
yarn content:list       # 列出 R2 对象
yarn run check          # tsc + ESLint + 单元测试
yarn e2e                # 针对 E2E_BASE_URL 运行 Playwright + axe（默认 http://127.0.0.1:3000）
yarn audit:deps         # 生产依赖审计关卡（security/audit-allowlist.json）
yarn db:status          # 各 SQLite 库的 schema 版本（只读）
yarn db:migrate         # 执行待迁移（启动时也会自动执行）
node scripts/perf-budget.mjs          # 对最近一次 `yarn build` 做性能预算检查
node scripts/subset-fonts.mjs         # 重新切分 Geist 字体（需要 fontTools 与 brotli）
node --import ./tests/register.mjs scripts/bake-images.mjs           # 为 public/images 中的照片生成变体
node --import ./tests/register.mjs scripts/ci/fixture-store.mjs      # 把合成数据存储装进一份全新的检出
node --env-file=.env scripts/cloudflare-config.mjs --dry-run   # Cloudflare 区域配置
node scripts/ai-trial.mjs [--fake-model]   # 在关联的 worktree 中本地试用 AI：只绑定回环地址、合成内容（docs/ai-trial.md）
bash scripts/ai-e2e.sh                # 在 standalone 服务器上运行 AI 端到端关卡
MCP_CONFORMANCE_TOKEN=<pst_ token> bash scripts/mcp-conformance.sh http://127.0.0.1:<port>   # MCP 一致性测试 + Inspector
node --import ./tests/register.mjs scripts/ai-live-smoke.mjs --real <preset>=<model>   # 真实服务商、真实密钥、真实费用
scripts/deploy.sh                     # 把 main 部署到服务器（docs/zh/deployment.md）
```

## 质量关卡

项目没有托管 CI（`.github/` 只有 issue 与 pull request 模板以及 `dependabot.yml`，没有 `workflows/`）：推送到 `main` 之前请运行以下检查。

| 命令 | 必须通过 | 何时必须运行 |
|---|---|---|
| `yarn run check` | `tsc --noEmit`、零警告的 ESLint（`--max-warnings 0`）、`node:test` 单元测试（`tests/*.test.ts`；`tests/no-network.mjs` 拒绝任何离开本机的网络请求；不需要 `.env`） | 每次推送 |
| `yarn build`，然后 `node scripts/perf-budget.mjs` | `next build --webpack`，以及性能预算（`scripts/perf-budget.mjs`，单位 KiB gzip）：共享首屏 JS ≤ 175，`pages/_app` ≤ 80，任一公开页面 ≤ 225，`/` ≤ 222，共享 CSS ≤ 8，最多 2 个字体预加载且合计 ≤ 75，且任何客户端代码块中都不得出现服务器专用标记——`anthropic-version`、`modelcontextprotocol`、`AI_KEYS_SECRET` | 每次推送 |
| `yarn e2e` | Playwright + axe（`e2e/`，[docs/zh/architecture.md → 测试套件](architecture.md#测试套件)），针对 `E2E_BASE_URL`（默认 `http://127.0.0.1:3000`）；`@admin` 用例需要 `ADMIN_EMAIL` / `ADMIN_PASS` 且会修改内容，除非数据存储可丢弃，否则加 `--grep-invert @admin` | 公开 UI 的改动；部署之后针对该部署 |
| `yarn audit:deps` | `scripts/check-audit.mjs`：生产依赖中不得有高危或严重漏洞，除非在 `security/audit-allowlist.json` 中写明理由与到期日；过期条目同样失败 | 每次推送 |
| `bash scripts/ai-e2e.sh` | 在镜像实际运行的 **standalone** 服务器上测试 AI 流程：从检出的临时副本构建，使用合成数据存储、不带任何 env 文件，旁边在回环地址上运行脚本化测试模型（`tests/helpers/fake-llm.mjs`）：Playwright 项目 `ai-admin`（Chromium）与 `ai-consent-firefox`（Firefox）。需先运行一次 `yarn playwright install chromium firefox` | 修改 `lib/ai`、`lib/mcp`、`components/Admin/ai` 或 AI 路由时 |
| `bash scripts/mcp-conformance.sh` | 针对开启了 AI 的本地构建与一个个人令牌：`@modelcontextprotocol/conformance`（2026-07-28 与 2025-11-25 两版规范，附经审阅的基线 `tests/mcp-conformance-baseline.yml`，过期条目同样失败）、授权服务器的元数据场景，以及 Inspector CLI 的 legacy、auto、modern 三种协议、`--strict` 与 401 路径 | 同上的 AI 改动 |
| `scripts/check-container.sh` | 合并后的 compose 配置只暴露回环地址，并保留加固项与静态资源归档卷；镜像能构建、在只含 git 种子的全新数据目录上启动、提供服务、预热 ISR 页面，以 uid 1001 运行、没有任何 capability 且 `NoNewPrivs` 生效；针对该容器运行的 Playwright + axe 测试在 Chromium（桌面、平板、手机、减少动效）与 WebKit（iPhone）中全部通过，随后是 `@admin` 用例（使用一次性的管理员账号）；8 秒内停止。需要 Docker、`jq` 与 `curl`；`--no-e2e` 可跳过测试套件 | 修改 Dockerfile、`docker-entrypoint.sh` 或 compose 文件时 |
| `scripts/check-fixture-gates.sh` | 在固定版本的 Playwright 镜像（视觉基线即在其中生成）中构建并运行合成数据存储（`e2e/fixtures/store`：*Example Person* 与程序生成的图片，绝不取自线上内容）：在校准过的手机配置下 CLS ≤ 0.05、TBT ≤ 200 ms；Chromium、WebKit（iPhone）与 Firefox 在 375 / 768 / 1440 下无横向滚动；图片不超过 200 KB；文章页 axe 检查；以及首页、文章、案例、简历与联系页（深 / 浅色 × 手机 / 平板 / 桌面）的视觉基线。`--update-snapshots` 在有意的改动后重新生成基线。需要 Docker | 公开 UI、图片、字体或性能预算的改动 |
