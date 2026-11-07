# Docker、部署脚本与 Cloudflare

属于 [Portfolio Studio](../../README.zh.md) · 返回[部署](../../README.zh.md#部署) · 英文版：[docs/deployment.md](../deployment.md)

本页说明如何把一个部署放到服务器上，不绑定任何主机：Docker 镜像与两份 compose 文件、每台主机都需要的覆盖文件约定、容器内的启动顺序、`scripts/deploy.sh` 的逐步流程，以及可选的 Cloudflare 区域配置与缓存清除。部署站点自己的地址写作 `https://example.com`；脚本操作的主机是 `$DEPLOY_HOST`；该主机上的备份目录是 `$BACKUP_ROOT`。每个环境变量都写在 [`.env.example`](../../.env.example) 与 [docs/zh/operations.md → 环境变量](operations.md#环境变量) 里。

## Docker

```bash
cp .env.example .env                                                 # JWT_SECRET, ADMIN_EMAIL, ADMIN_PASS at least
cp docker-compose.override.example.yml docker-compose.override.yml   # once per host; gitignored
docker compose up -d --build                                         # http://127.0.0.1:3002
```

**覆盖文件约定。** `docker-compose.yml` 是基础文件：镜像 `hiko-landing-page-frontend-ts-staging:latest`、`env_file: .env`、`restart: unless-stopped`、`mem_limit: 1g`、`cpus: 2`、`cap_drop: ALL`、`no-new-privileges:true`、`pids_limit: 256`，具名卷 `landing-data`（`/app/data`）、`landing-uploads`（`/app/public/uploads`）与 `landing-static-archive`（`/app/next-static-archive`），端口 `127.0.0.1:8000:3000`，以及名为 `easilycv` 的外部网络。`docker-compose.override.yml` **不纳入版本库**：每台主机按 `docker-compose.override.example.yml` 保留自己的副本，`docker compose` 会自动合并。示例文件把端口换成 `127.0.0.1:3002:3000`（`ports: !override`；主机上的反向代理或隧道从这里接入，其他任何东西都到不了容器），把网络换成默认网络（`networks: !override`），用 `./data` 与 `./public/uploads` 的绑定挂载取代两个数据卷（容器以 uid 1001——镜像的非 root 用户——写入它们；Linux 主机上请让该 uid 可写），并轮转容器日志（`local` 驱动，5 × 10 MB）。它不能对 `volumes` 列表使用 `!override`，否则每次部署都会丢掉静态资源归档卷。`scripts/check-container.sh` 会断言合并后的配置只发布回环地址并保留加固项。

根文件系统保持可写：ISR 会改写 `/app/.next/server` 下的预渲染页面；要改成只读，需要把该目录放到每次部署都从镜像重新初始化的卷上。页面变成 404 时（删除或撤回发布的文章与案例、没有公开论文的 `/publications`），每次内容写入后及启动时都会删除它在该目录下的持久化副本（`lib/isrCache.ts`、`lib/isrPages.ts`），否则重启后 Next 会再次提供最后一份 200 副本。

**镜像。** 使用 BuildKit 构建（`# syntax=docker/dockerfile:1.7`）：yarn 与 Next 的缓存放在缓存挂载中；`yarn.lock` 与依赖不一致时 `yarn install --frozen-lockfile` 会让构建失败；两个阶段都使用按 digest 固定的 `node:22-alpine`（Dependabot 会提出 digest 更新）；`yarn build` 之前先运行 `scripts/bake-images.mjs`；构建时产生的 `content.db` 会被删除；去掉 glibc 版 sharp 二进制（Alpine 使用 musl）；发布阶段只包含 Next 追踪出的 standalone 输出——构建时会校验内容脚本所需模块（`better-sqlite3`、`gray-matter`、`@aws-sdk/client-s3`、`sharp`）都能从中加载。容器以 uid 1001（`nextjs`）运行，暴露 3000 端口，每 30 s 对 `/api/health` 做一次 `HEALTHCHECK`。运行时配置来自 `.env`（`env_file`）；`NEXT_PUBLIC_SITE_HOST`、`NEXT_PUBLIC_PRODUCT_NAME`、`NEXT_PUBLIC_DEFAULT_THEME` 与 `NEXT_PUBLIC_BUILD_SHA` 同时也是构建参数（`docker-compose.yml` 从 `.env` 转发它们），因为 Next 会在构建时把它们写进前端代码，所以改动其中任何一个都需要 `--build`。`NEXT_PUBLIC_BUILD_SHA`（由部署脚本设置）把部署的提交显示在 `/colophon` 上。

**启动顺序。** `docker-entrypoint.sh` 由 `dumb-init` 托管（PID 1，`docker stop` 才能到达服务器）：先运行 `scripts/sync-from-r2.mjs`，按真实时间戳对齐本地 SQLite 与 R2 镜像，并补齐此前未能写入 R2 的内容——退出码 0 或 3（R2 失败但本地内容完整）继续，其他情况拒绝提供空站点、由重启策略重试；接着运行 `scripts/static-archive.mjs`（见下）；随后在后台运行 `scripts/warm-isr.mjs`，等服务器健康后用真实数据重新生成所有静态页面（镜像构建时不含数据库）；最后 `exec node server.js`。`./data` 与 `./public/uploads` 通过卷或绑定挂载持久化。

**保留早先构建的静态资源。** 每次构建的 chunk 文件名都不同，而镜像只带有自己的 `.next/static`。为了让部署前打开的页面（会按需加载 chunk 的已打开标签页，或仍在边缘缓存里的 HTML）继续正常工作，`landing-static-archive` 卷（`/app/next-static-archive`）会在启动时收集每次构建的 `/_next/static` 文件，并把最近一周（`STATIC_ARCHIVE_DAYS`，1 至 90，默认 7）部署过的构建的文件复制回新构建旁边——绝不覆盖新构建自己的文件（所有文件名都是内容哈希或构建 id）。它只存构建产物（每次构建几 MB），随时可以删除。

在容器内可以用 `docker compose exec landing-page node scripts/migrate-db.mjs --status` 查看迁移状态，用 `docker compose exec landing-page node scripts/edge-purge.mjs --dry-run` 检查边缘缓存清除的配置。

## 部署到生产环境

`scripts/deploy.sh [--force]` 是唯一的部署路径。它在你的电脑上运行，通过 `ssh $DEPLOY_HOST`（`~/.ssh/config` 中的别名；`DEPLOY_HOST`、`DEPLOY_DIR` 与 `DEPLOY_SITE_URL` 是脚本开头读取的环境变量覆盖项，脚本里的默认值属于最初的那次部署）操作一台服务器。服务器上没有 GitHub 凭据：新提交以 git bundle 的形式传过去。

```bash
git switch main && git pull && git push   # main == origin/main
scripts/deploy.sh                         # --force rebuilds the deployed commit
```

1. **预检**——工作区干净、位于 `main`、`main` 已推送到 `origin`、服务器可达，且服务器 HEAD 是 `main` 的祖先（只允许快进）。
2. **备份**到服务器上的 `$BACKUP_ROOT/<UTC 时间戳>/`（`BACKUP_ROOT` 是脚本远端部分的一个常量）：通过运行中容器里 better-sqlite3 的 `.backup()` 在线备份各个库，打包 `data/`（不含其自身的 `backups/`）与 `public/uploads/`，复制 `.env` 与 compose 覆盖文件；当前镜像打上 `<image>:pre-<时间戳>` 标签。
3. **更新**——检出目录从 bundle 快进。服务器自己的 `data/home.json` 和 `docker-compose.override.yml` 逐字节保留；出现其他本地修改则中止部署。本次更新删除、且此后被 `.gitignore` 忽略的文件在服务器上保留原副本。
4. **构建**——执行 `docker compose build`，旧容器继续提供服务。构建失败时恢复检出目录，其余一切未变。
5. **切换**——`docker compose up -d --no-build`，然后等待容器变为 `healthy` 并输出 `[warm-isr] regenerated`、`/api/health` 返回 `"status":"ok"`，且端口只绑定在 `127.0.0.1`。
6. **清除边缘缓存**——ISR 页面可以被边缘缓存，而上一次构建的 HTML 引用的 chunk 新镜像里已经没有了。部署脚本在新容器内运行 `scripts/edge-purge.mjs`，用应用自己的 `CF_ZONE_ID` + `CF_API_TOKEN`（Cache Purge 权限，令牌不离开服务器）清除 Cloudflare 区域缓存：先 `purge_everything`；若 Cloudflare 拒绝，则按每批 30 个清除所有可缓存的页面、订阅源与站点地图中的 URL。没有凭据（或清除失败）时，部署只打印警告并继续：Cloudflare 本来就最多保留 HTML 5 分钟（对共享缓存寿命更长的 HTML——`/`、`/about`、`/colophon`——源站会发送 `Cloudflare-CDN-Cache-Control: max-age=300, stale-if-error=86400`，见 `lib/edgeHtmlTtl.ts`），而这期间旧 HTML 仍能正常水合，因为早先构建的静态资源会被保留（见上文 Docker）。这个上限始终开启，而不仅在没有凭据时：清除可能失败，构建时也无法知道运行时的凭据，而每个边缘节点每隔几分钟从 ISR 缓存重新取一次几乎没有成本。
7. **冒烟测试**——经 `DEPLOY_SITE_URL` 访问主要页面、订阅源、站点地图、健康检查和旧 CV 跳转（带破缓存参数，确保由新的源站响应）；`/` 必须引用新的构建 id（`.next/BUILD_ID`）。随后不带查询串再请求 `/`——也就是访客从边缘拿到的版本——检查是否也是新构建 id（重试几次）；边缘副本过期只报告、不回滚（源站正常，回滚也刷新不了边缘，而且旧副本仍能工作）。
8. **回滚**——切换后任何一步失败都会执行 `docker tag <image>:pre-<时间戳> <image>:latest && docker compose up -d --no-build`，恢复检出目录，并打印失败容器最后 100 行日志和备份路径。成功时写入 `.deployed-sha` 并清理旧镜像（保留最近三个回滚镜像），同时清理备份：只保留最新的十个 `<UTC 时间戳>/` 备份目录（`KEEP_BACKUPS`；每个都含一份 `.env`），逐一列出被删除的目录，`$BACKUP_ROOT/` 中的其他内容一概不动。

部署后对生产环境运行公开部分的端到端测试：

```bash
E2E_BASE_URL=https://example.com yarn e2e --grep-invert @admin
```

## Cloudflare

可选：站点可以放在任何反向代理之后。`scripts/cloudflare-config.mjs` 把区域配置保存在仓库中，并以幂等方式应用（先读取每项设置与规则集，只写入有差异的部分并打印差异；`--dry-run` 不写入任何内容；任何 API 错误都以退出码 1 结束）。它管理的规则带有 `lp_` 前缀的 ref（`REF_PREFIX`）；在控制台中手动添加的规则会被保留。

- 区域设置：开启 **Always Use HTTPS**，关闭 **Email Address Obfuscation**（它改写的 HTML 会破坏 React 水合）。
- 针对站点域名的配置规则：关闭邮箱混淆，关闭 Web Analytics（RUM）脚本注入——站点有自己的统计，CSP 保持不变。
- 跳转规则：`www.<域名>` → `https://<域名><路径>`（308，保留查询串）；缺少时会创建经代理的 `www` CNAME。
- 缓存规则：公开页面、订阅源、站点地图、`/api/og`、`/api/stack`、`/api/search-index` 与 `/api/github/*` 允许缓存，边缘 TTL 取自源站（ISR 页面带 `s-maxage`；服务端渲染页面发送 `no-store`，不会被缓存）；`/admin*`、`/api/admin*`、`/api/auth*` 以及任何带管理员会话 Cookie 的请求都绕过缓存。

```bash
CF_API_TOKEN=<token> CF_ZONE_ID=<zone-id> node scripts/cloudflare-config.mjs --dry-run
CF_API_TOKEN=<token> CF_ZONE_ID=<zone-id> node scripts/cloudflare-config.mjs
```

域名取自 `.env` 中的 `NEXT_PUBLIC_SITE_HOST` / `SITE_URL`（`node --env-file=.env`），或 `--host <host>`。这次一次性运行所需的令牌权限：Zone Settings:Edit、Config Rules:Edit、Cache Rules:Edit、Dynamic Redirect:Edit、DNS:Edit，以及可选的 Account Analytics:Edit（没有它时，脚本会打印在控制台中手动关闭 Web Analytics 自动安装的步骤）。请使用短期令牌，用完即吊销。

运行时，设置 `CF_ZONE_ID` + `CF_API_TOKEN`（只需 Cache Purge 权限的令牌）后，每次按需重新生成页面都会以每批 30 个清除刷新过的 URL——文章或案例变化时还会清除订阅源、站点地图与搜索索引；设置 `INDEXNOW_KEY` 后，页面 URL 会推送给 IndexNow（密钥文件位于站点根目录 `/<INDEXNOW_KEY>.txt`：密钥文件只对其所在目录及以下的 URL 有效；代理只把这一个路径改写到 `/api/indexnow-key`）。两者都是发出即不等待、3 秒超时、记录日志，且绝不会导致保存失败（`lib/revalidate.ts`）；未设置环境变量时什么都不发送。每次部署后也用同一组凭据清除整个区域（`scripts/deploy.sh`、`scripts/edge-purge.mjs`），并且 HTML 在边缘最多保留 5 分钟（`Cloudflare-CDN-Cache-Control`，只有 Cloudflare 读取；`lib/edgeHtmlTtl.ts`）。
