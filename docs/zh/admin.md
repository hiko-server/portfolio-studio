# 后台工作台：逐页说明

属于 [Portfolio Studio](../../README.zh.md) · 返回[功能一览](../../README.zh.md#功能一览) · 英文版：[docs/admin.md](../admin.md)

本页面向在 `/admin` 里的站长：每个后台页面及其用途、首页的板块开关、开源板块背后的 GitHub 数据与组织、currently-coding 芯片、统计视图、联系收件箱与内容健康。写作工具与 CV 工作台另有专页 [docs/zh/authoring.md](authoring.md)；备份、健康与操作日志在 [docs/zh/operations.md](operations.md)；AI 在 [docs/zh/ai.md](ai.md)。

## 后台页面

| 路由 | 用途 |
|---|---|
| `/admin/login` | 登录（隐蔽入口：导航无可见链接；走 ⌘K 命令面板或直接输 URL） |
| `/admin/forgot` + `/admin/reset` | 邮件密码重置流程 |
| `/admin` | 状态中心：需要处理的事项、实时计数、各编辑器入口 |
| `/admin/dashboard?tab=home` | 首页编辑器（Home editor）——Hero、成就条、板块顺序与可见性、可用状态（求职意向、工作许可）、品牌、照片、联系表单文案与来意选项、开源（GitHub 组织、置顶仓库） |
| `/admin/dashboard?tab=cv` | CV 工作台（CV Studio：逐字段可见性、隐藏项面板、面向招聘者的就绪检查——`&panel=readiness`、A4 / 网站预览）、`&view=raw`（原始 JSON 编辑器）与 `&view=variants`（定制版本与私密链接） |
| `/admin/dashboard?tab=versions` | 版本历史回滚 |
| `/admin/dashboard?tab=storage` | SQLite + R2 清单、「立即备份（Backup now）」、「拉取最新（Pull latest）」 |
| `/admin/dashboard?tab=inbox` | 联系收件箱——文件夹、来意、搜索、星标 / 归档 / 已回复、带中英模板的线程回复、可撤销的删除 |
| `/admin/dashboard?tab=analytics` | 第一方访问量、来源、设备、真实用户 Web Vitals、目标、「来源 → 简历 → 下载」转化与无结果的搜索 |
| `/admin/blog`、`/admin/blog/edit?slug=<slug>` | 文章管理：草稿、已上线文章的待发布修改、发布检查清单、实时预览、历史、带跳转的网址改名、搜索与分享预览 |
| `/admin/work`、`/admin/work/edit?slug=<slug>` | 案例管理（同样的工具） |
| `/admin/tags` | 文章标签与案例技术栈的重命名、统一写法、合并；内容导出（.zip） |
| `/admin/media` | 媒体库：上传图片及其使用位置、默认替代文本与图注、替换文件、回收站（`?view=trash`）、R2 检查 |
| `/admin/publishing` | 定时与审阅链接（Scheduled & review links）：将自动上线或下线的内容、定时器状态、每条有效的审阅链接 |
| `/admin/now`、`/admin/uses`、`/admin/about` | 单页编辑器（`about` = /about 上的自述；留空则不显示自述板块） |
| `/admin/db-config` | MongoDB 连接 + 手动备份 / 恢复 |
| `/admin/security` | 通行密钥、恢复码、修改密码、「必须使用通行密钥（Require a passkey）」、已登录的浏览器、登录记录 |
| `/admin/system` | 系统健康（构建、磁盘、数据库、备份、恢复演练、近期警告）、`?view=content`（内容健康）、`?view=errors` 与 `?view=activity`（操作日志） |
| `/admin/ai` | AI：助手（默认）、`?view=changes`（AI 提议与完成的改动：批准、拒绝、撤销，以及每次工具调用）、`?view=connections`（开关、连接应用、个人令牌、已连接的应用）与 `?view=models`（模型密钥、助手设置、用量、哪些数据会离开本站） |
| `/admin/ai/change/<id>` | 单个 AI 改动：卡片、完整差异与预览 |
| `/admin/ai/connect` | 应用连接时跳转到的 OAuth 同意页 |

在任意后台页面按 `?` 可查看（并搜索）键盘快捷键。后台以键盘为先：⌘K / Ctrl+K 列出所有后台页面与当前视图的操作（后台视图通过 `useAdminCommands` 加入自己的操作，`components/Admin/shell/useAdminCommands.ts`）；`G` 加字母跳转——`D` 总览、`I` 收件箱、`R` CV 工作台、`E` 首页编辑器、`P` 文章、`O` 案例、`M` 媒体库、`T` 统计、`V` 版本、`F` 存储、`S` 系统健康、`L` 操作日志、`Q` 内容健康、`X` 错误、`K` 安全、`Y` 定时与审阅链接、`J` AI 助手（`components/Admin/shell/adminCommands.ts`；公开页面的 `G H/A/W/B/C/N/U` 同样可用）；列表支持 `j` / `k`、`Enter`、`x` 及各自的字母（收件箱：`r` 回复、`s` 星标、`e` 归档、`u` 未读、`#` 删除、⌘Z 撤销）。单键快捷键受「Single-key shortcuts」开关控制。

每个后台页面都带 `X-Robots-Tag: noindex, nofollow, noarchive` 与 `Cache-Control: no-store`；代理鉴权门与登录相关的控制见 [SECURITY.md → Authentication and sessions](../../SECURITY.md#authentication-and-sessions)（英文）。

<img src="../../docs/screenshots/admin-home.png" width="900" alt="首页编辑器：带可见性复选框的板块列表与 Hero 表单">

## 分节可见性

首页每个板块都经过 `isSectionVisible(home, key)`（`lib/homeShape.ts`），`key` 为 `introduction`、`highlights`、`brands`、`open-source`、`tech-stack`、`activity`、`projects`、`publications`、`writing`、`experience`、`certifications`、`photos`、`contact` 之一。键缺失默认*显示*——新装实例自带完整页面。带编号的板块按 `home.sectionOrder` 排列，经 `resolveSectionOrder`（`lib/homeSections.ts`）读取：未知的键被丢弃，旧文档里缺少的板块插回默认位置，因此旧文档永远不会隐藏某个板块。

入口：**后台 → Home → Sections**（「Recruiter-first」把项目、经历、论文、写作与技能排到 GitHub 动态之前；`lib/homeSections.ts` 中的 `RECRUITER_SECTION_ORDER`）。

## GitHub 数据与组织

开源板块、动态流和后台的置顶仓库选择器都在服务端读取 GitHub（`lib/githubData.ts`；浏览器从不直接请求 GitHub）。登录名取自 **后台 → Home → Socials** 里的 GitHub 链接。仓库是该账号的公开仓库，**加上** **后台 → Home → Open source → Organizations** 中列出的 GitHub 组织的公开仓库（`home.openSource.orgs`，最多 10 个）。组织永远不会因「是成员」而自动加入：只列出其中作品确属你本人的组织。添加时会到 GitHub 核对（`GET /api/admin/github-org`：显示名称与仓库数，或「不存在」「限流」「GitHub 不可用」），并在选择器里以 `org / name` 列出它的仓库；已保存的组织在打开编辑器时显示本站自己那份列表的状态（不再向 GitHub 查询，所以重开编辑器不消耗请求）。移除组织后可在提示条里撤销。

- **计入范围**——个人账号与每个组织同一规则：只算公开仓库，不含 fork 和以点开头的仓库（`.github`），已归档的仍计入。「Public repos」与「Total stars」两格正是这一集合，语言条和动态的后备列表（90 天事件流为空时）也用它。
- **置顶仓库**——个人仓库按名称保存，组织仓库保存为 `org/name`（所有者须是合法的 GitHub 登录名，仓库名最多 100 个字符）。纯名称永远指个人仓库（fork 也算），即使某个组织有同名仓库；个人账号没有时，取列表中排在最前的组织。编辑器按与页面完全相同的规则解析，置顶仓库所属组织已不在列表中时会直接说明。
- **页面展示**——组织仓库的卡片显示 `example-org / name`；卡片较窄时仓库名换到 `example-org /` 下面单独一行，而不是被截断。个人仓库卡片保持原样。
- **失败处理**——改名、删除或暂时连不上的组织会被跳过（只记一次日志），其余照常显示；只有个人列表失败时，板块才显示 GitHub 不可用。
- **缓存**——每个列表（个人、每个组织）和每个仓库的语言统计各占一个内存缓存项，并采用 stale-while-revalidate，因此改动组织只会加载新增部分；保存或恢复（首页编辑器、版本历史、MongoDB 备份）后会先加载新列表再重新生成页面（配置了 Cloudflare 时随后清除 `/api/github/*` 的边缘缓存）。
- **限流是强制执行的，而不是估算**——未配置 token 时 GitHub 每个 IP 每小时允许 60 次请求。`ghFetch`（`lib/github.ts`）在任意 60 分钟内最多发出 45 次；后台刷新（期间继续返回旧值）只在最近 60 分钟发出不足 30 次时才进行；GitHub 自己返回的 `x-ratelimit-remaining` 更少时以它为准。没有余量的请求不会发出：保留旧值，或该部分稍后再加载。TTL（`lib/githubData.ts` 的 `GH_TTL`）让平均值低于这个上限，但同时加载的缓存项会同时过期，所以兜住最坏一小时的是这个上限而不是平均值——`tests/github-budget.test.ts` 模拟了这些时段。配置 `GITHUB_TOKEN` 可把额度提高到 5000（按同样比例），并启用 GraphQL 贡献日历。

## Currently-coding 芯片

头像下方的三行小字（`label / project / note`）。每行独立按**后台手填 → 从 CV 推导 → 留空**的优先级合并：

- 后台手填非空 → 用手填值。
- 否则由 `lib/currentlyCoding.ts` 从内容存储中的 CV 文档推导（纳入版本库的 `data/cvdata.json` 只是示例种子）：`label` → `"currently coding"`；`project` → 「当前最相关」的 `workExperience.companyName`（优先在职岗位，按开始日期升序；都已结束则取最近结束的一份）；`note` → `"since <最早年份>"`，取所有带日期简历条目的最小年份。
- 三行合并值全为空时整个芯片才会隐藏。

后台编辑器把推导值作为输入框的 placeholder 显示，并在下方加一行小字 `Auto-derived now:`，让运营者一眼看到留空时访客会看到什么。

## 探索数据

后台 → 统计（Analytics）：选择时间段（预设、自定义区间，或用 ‹ › 前后翻动），打开「Compare」即可在图上叠加上一个同长时段；可按页面、来源、国家、设备、浏览器或页面语言筛选——从 Filter 选择器添加，或直接点击任意表格行；所有卡片、目标、转化、「Paths to a goal」以及 Web Vitals（仅按页面与设备）都随之变化，视图保存在 URL 中。筛选依赖原始记录，所以筛选后的视图最多覆盖最近 35 天，并会明确说明；不筛选时整个时段来自每日汇总。筛选到单个页面会显示该页详情（读到文末、邮件与外链点击、该页的 Web Vitals），文章编辑器的 ⋯ 菜单也能直接打开。「Export」把当前视图导出为 CSV（单张表，或全部表打包为 .zip——从不包含搜索文字）；开启「Weekly digest」后，每周一（UTC 01:00 起；`lib/analytics/digestSchedule.ts`）把上周汇总发到 `NOTIFY_EMAIL`，需要配置 SMTP，卡片里写明了设置方法。不新增任何访客数据；analytics 迁移 7 只增加两个索引和一张按日的页面语言汇总。记录什么、保留多久，概要见 README 的[隐私与安全](../../README.zh.md#隐私与安全)一节。

细则（`lib/analytics/ingest.ts`、`lib/analytics/events.ts`）：浏览器发送 `DNT: 1` 或 `Sec-GPC: 1` 时、爬虫、已登录的站长（`cv_admin_token` / `cv_admin_hint` Cookie）以及公开页面以外的路径，什么都不记录。不保存 IP 地址与 User-Agent：访客标识是 `sha256(每日盐 + 站点域名 + IP + User-Agent)` 截取的 16 位十六进制，盐是随机的、在 UTC 零点轮换且只存在于内存中（重启也会换新盐），因此同一个人无法跨天关联。每次访问只保留路径、来源域名（仅当来自其他站点）、国家（Cloudflare 的 `cf-ipcountry`）、粗略的设备与浏览器类别、页面语言；Web Vitals 只保留路由、指标、数值与评级。目标事件（`POST /api/g`，其中 `cv_download`、`vcard_save` 与 `contact_sent` 由服务器计数）只有固定的八个名称：`cv_download`、`cv_print`、`vcard_save`、`email_click`、`outbound_click`、`contact_sent`、`read_through` 与 `search_empty`。原始访问记录保留 35 天，原始 Web Vitals 30 天，原始目标事件 35 天，按日汇总 400 天；`search_empty` 的原始记录与每日汇总都只保留 35 天。

## 联系留言

- 表单在发送按钮旁说明保留什么、保留多久。一条留言（姓名、邮箱、主题、正文，以及可选的结构化信息：原因、类别、公司、一个链接、时间线）存于 `data/contact-inbox.jsonl`，配置了 SMTP 时还会发邮件给站长。链接只接受 https，服务器从不抓取它。表单带签名的一次性 nonce（加载与发送之间至少 2 s）、一道算术题与蜜罐，不用外部验证码（`pages/api/contact.ts`、`pages/api/contact/nonce.ts`、`lib/security/contactChallenge.ts`）；收件箱全站每个 UTC 日最多接受 300 条留言（`lib/inbox.ts`）。
- 在后台 → 收件箱（Inbox）中，每条留言可以星标、归档、标为已回复并用邮件回复。回复**从 SMTP 账号自己的地址发出**（这样能通过收件方的 DMARC 检查——`p=reject` 的域名若经其他服务商「以该域名」发出会被拒收），**Reply-To** 设为网站显示的邮箱，并与你收到的通知邮件组成线程（Message-ID、In-Reply-To、References）。模板（英文与中文，占位符 `{firstName}` `{name}` `{subject}` `{me}`）属于内容，存在内容存储里；状态与已发出的回复留在服务器上、与收件箱放在一起，随留言一起删除。没有 SMTP 时，撰写框会说明配置方法，并在你的邮件程序中打开同一份草稿（`lib/inboxReply.ts`、`lib/inboxTemplates.ts`）。
- 超过 `CONTACT_RETENTION_DAYS`（默认 365）天的留言由每晚 19:00 UTC 的任务删除（`lib/inboxRetention.ts`）；在此之前列表就已隐藏它们，恢复不会把它们合并回来，超过期限的全站快照也会被清理（最新一份始终保留）。部署脚本的每次部署备份（服务器上的 `$BACKUP_ROOT/<时间戳>/`，保留最新十个；`scripts/deploy.sh`）同样含有一份 `data/` 副本，按数量轮转。

## 内容健康

后台 → 系统 → 内容（`/admin/system?view=content`，健康页有摘要）：检查所有已发布的文章、案例、页面、简历和首页——失效或已迁移的链接（每天一次、礼貌的外链检查：经 `safeFetch`、先发 HEAD、同一站点一次只发一个请求，结果存于 `data/content-health/links.json`；LinkedIn 的 999 和机器人拦截算作「无法验证」，不算失效；周期由 `LINK_CHECK_INTERVAL_HOURS` 决定，默认 24）、指向不存在或草稿文章的链接、链接里的跟踪参数、缺失 / 外链 / 过大 / 缺少响应式尺寸 / 用文件名当替代文本的图片、标题层级、重复或缺失的描述，以及硬换行。能安全修复的一键完成——去掉跟踪参数、把外链图片导入上传目录、生成响应式尺寸、改用链接的新地址、删掉多余的换行——都走编辑器自己的保存流程（版本快照、R2 镜像、页面重新生成；若内容在报告之后改过则以 409 拒绝）；需要你亲自措辞的则链接到编辑器。`j` / `k` 浏览问题，`f` 应用当前问题的修复。
