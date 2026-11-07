# 写作与 CV 工作台

属于 [Portfolio Studio](../../README.zh.md) · 返回[功能一览](../../README.zh.md#功能一览) · 英文版：[docs/authoring.md](../authoring.md)

本页面向作为编辑的站长：文章与案例的 MDX 正文接受什么写法，可视化编辑器、译文、定时发布与审阅链接如何工作，简历的可见性开关、受众与定制版本如何决定每位读者看到的内容，论文如何呈现，以及如何连接 ORCID iD。路径指向承载每条规则的代码。

## 撰写文章与案例

正文是 Markdown（GFM），外加一小组不做 eval 的 MDX 组件（`lib/mdx.ts`，`lib/rehype/` 下的 rehype 插件）。在常规 Markdown 之外：

| 写法 | 效果 |
|---|---|
| 单独成段的 YouTube 或 Vimeo 链接，裸链接或 Markdown 链接均可 | 点击加载的播放器。保存时封面会复制一份到 `/uploads`；读者按下播放之前，不会从视频站点加载任何东西 |
| 引用块首行写 `> [!NOTE]`（或 `TIP`、`IMPORTANT`、`WARNING`、`CAUTION`） | 一个提示框，标签随文章语言 |
| `![alt](/uploads/x.webp#wide)` / `#full`，或 `<Figure size="wide" />` | 比正文栏更宽的图（full：手机上通栏到边）。可视化编辑器里图的工具栏可以设置 |
| 连续两张以上图片（之间空行，或一行一张） | 按图片形状排版的图集；相同的图注只显示一次 |
| `[^1]` 脚注、`<details><summary>` 块 | 带样式的尾注与「深入阅读」折叠块 |

案例在编辑器里有一个 **At a glance** 区块（一句话成果、最多四项带出处的指标、团队、发表日期、附加链接）和封面焦点；页面只显示填写了的内容。新建案例时会提供一份带说明的模板；说明文字是 MDX 注释，从不出现在页面上，发布检查清单会指出遗留的注释。文章可以指定对应的案例（「Case study」字段），两个页面随即互相链接。标签与技术栈链接到 `/blog?tag=<tag>` 与 `/work?tag=<tag>`；`/work` 末尾列出简历中的每个公开项目（「All projects」），有案例的链到案例。

**可视化编辑器能处理所有这些。** 表格（增删行列、列对齐、表头行；Tab / Enter 在单元格间移动）、提示框（类型是一个菜单）、视频（在空行粘贴 YouTube / Vimeo 链接）、图（图下写图注、缺少替代文本时提示、正文 / 宽幅 / 通栏三种宽度），以及其他任何 MDX——JSX 组件、注释、脚注——都原样保留，显示为可编辑的源码块。块可以用手柄（拖动，或其菜单）和 Alt+↑ / ↓ 移动；粘贴的 Markdown 会变成结构。MDX → 编辑器 → MDX 无损：测试样例、本地内容库里的每篇文章，以及每次测试 1,000 篇随机文档往返后都编译出同一个页面（`components/Admin/RichEditor.tsx`、`components/Admin/editor/`、`e2e/editor-parity.spec.ts`）。文章封面同样可以设焦点，社交卡片围绕它裁切。

**中文与译文。** 中文文章或案例（自动识别，或在编辑器的「Language & translations」里设定）使用中文界面文字（日期 / 阅读 / ← 全部文章）与中文排版：约 34 字行长、1.85 行高、中西文之间加间距、着重号。要把同一篇内容同时以中英文发布，在该区块里给两个版本填同一个**翻译键**（或点那里的「Create draft」，把已保存的版本复制成另一种语言的新草稿再翻译）：每个页面随即出现「阅读中文版」/「Read in English」，搜索引擎得到 hreflang 互指，列表只显示一次、优先英文版（`lib/translations.ts`）。界面文字放在 `lib/uiStrings/`。

**图片。** 文章与案例中的每张图片（以及首页 Field Notes 的每张照片）都可打开全屏查看器——从原图位置放大展开，关闭时飞回原位：左右滑动切换，双指或双击缩放（页面本身从不缩放），下拉关闭；鼠标点击放大、滚轮缩放；键盘用方向键、+ / − / 0 与 Esc。手势引擎在 `components/Common/lightboxEngine.ts`，计算在 `lib/lightboxGestures.ts` 与 `lib/lightboxPhysics.ts`。

编辑已上线的内容从不会发布半成品：「保存修改（Save changes）」（⌘S）把改动存为*待发布修改*——访客仍看到已发布版本——直到点「发布修改…（Publish changes…）」（附差异对比）；预览在真实地址上显示这些修改（`lib/pendingRevisions.ts`）。网址旁的「修改…（Change…）」把条目搬到新地址：旧地址永久跳转，站内链接全部改写（`lib/slugRename.ts`、`lib/redirects.ts`）。正文下方的「搜索与分享（Search & sharing）」设置搜索标题、语言与「标记为已更新」，并预览谷歌搜索结果与领英、X、WhatsApp、Slack、微信的卡片。写作栏统计字数（中日韩按字计），提供查找替换（⌘F）、专注模式与打字机滚动。**后台 → 标签与导出（Tags & export）** 跨条目重命名或合并标签，并把全部内容下载为 Markdown + JSON 的 .zip（`pages/admin/tags.tsx`、`pages/api/admin/export.ts`）。可回滚的版本历史在 `pages/api/versions.ts`。

**先定时，后分享。** 「发布…（Publish…）→ 定时…（Schedule…）」设定草稿——或已上线条目已保存的修改——何时上线，以及可选的自动下线时间；时间按站点时区（`SITE_TIME_ZONE`，`lib/clock.ts`）选择与显示，设备时区不同时一并显示。到点由服务器自动执行，无需打开浏览器；停机期间错过的会在重启后补上，并重新生成页面、订阅源与站点地图，每次操作都以「Scheduler」为执行者记入日志（`lib/schedule/`；时间保存在条目的 `publishAt` / `unpublishAt` frontmatter 中）。「⋯ → 分享审阅…（Share for review…）」生成私密链接（1 小时至 30 天），以只读方式显示草稿并加「Preview」水印——从不被索引或缓存——记录打开次数，可随时关闭（`lib/review/`，令牌经签名、只以哈希存于 `auth.db`）。**后台 → 定时与审阅链接（Scheduled & review links）**（`/admin/publishing`）汇总两者。

## CV 可见性模型

所有标志都是可选的，现有简历数据无需改动即可继续使用（`lib/cvVisibility.ts`）：

| 层级 | 存储形式 | 效果 |
|---|---|---|
| 板块 | `isVisible: false` | 不出现在 A4 简历 / PDF 上 |
| 板块 | `showOnWebsite: false` | 不出现在 `/about` 或首页上 |
| 条目（列表中的任意对象） | `isVisible: false` | 处处隐藏 |
| 字段 | 对象上的 `hiddenFields: ["gpa"]` | 处处隐藏 |
| 要点 / 标签 | 父级上的 `hiddenItems: { "points": [2] }` | 处处隐藏 |

公开页面调用 `readPublicCvData`（`lib/cvdata.ts`）时带上受众与渲染的载体；未鉴权的 `GET /api/cvdata` 返回同样剔除后的视图。只有管理员会话能通过 `/api/admin/cvdata` 拿到完整文档。

无论开关如何设置，发布规则始终成立：个人信息里仅用于 PDF 的照片（`photo`、`photoOnPdf`）从每个公开视图中移除，由服务端 PDF 单独读取；推荐语只在其 `permission` 为 `true` 时公开；工作台里被忽略的就绪检查（`readinessDismissed`）从不离开后台。

## 受众与定制版本

除眼睛图标外，每个字段、条目、列表与板块都有 **Shows on（显示于）**：公开页面、下载文件（PDF / 纯文本 / JSON Resume / vCard）与私密链接——例如电话号码可以不出现在 `/cv` 与 `/api/cvdata`，却保留在 PDF 中；隐藏始终优先。简历中的每条要点在眼睛图标旁也有自己的「Shows on」菜单。

在 Dashboard → CV → **Variants & links**（`/admin/dashboard?tab=cv&view=variants`）中，站长可以建立「机器学习」「嵌入式」等版本，挑选并排序板块与条目，按真实 PDF 衡量页数目标，并通过带签名、会过期、可随时撤销的私密链接（`/cv/r/<token>`，只保存哈希；noindex / no-store / no-referrer）连同其 PDF（`/cv/r/<token>/en.pdf`、`/cv/r/<token>/zh.pdf`）分享其中一个；每条链接只显示打开次数与最近一次打开的日期。最多保留 24 个版本（`MAX_VARIANTS`，`lib/cvVariants.ts`）；链接存于 `auth.db`（`lib/cvShare/`）。逻辑位于 `lib/cvVisibility.ts`、`lib/cvVariants.ts`、`lib/cvShare/`。

简历本身可下载为服务端渲染、带标签、内嵌字体的 PDF（`/cv.pdf`、`/cv/zh.pdf`；`lib/cvExport/pdf.ts`，使用 pdfkit、Geist 与 `assets/pdf` 中的 Noto Sans SC 子集）、纯文本（`/cv.txt`）与 JSON Resume 1.0.0（`/cv.json`；`lib/cvExport/jsonResume.ts`）。CV 工作台面向招聘者的就绪检查在 `lib/cvReadiness.ts`（`/admin/dashboard?tab=cv&panel=readiness`），技能出处在 `lib/skillEvidence.ts`。

## 论文

简历中的论文板块（论文、预印本与学位论文：作者按顺序、发表载体、状态、DOI、链接、摘要），在 `/cv`、`/cv/zh`、阅读视图、A4 页面与可下载的简历（中英文 PDF、纯文本、JSON Resume 的 `publications`）中以引用格式呈现，并在 `/publications` 提供 BibTeX / APA 复制与 ScholarlyArticle JSON-LD。首页可显示 **Selected Publications** 板块（由站长排序，默认位于项目之后），/about 侧栏链接论文列表并显示篇数，⌘K 可搜索每篇论文，论文关键词计入技能出处，首页编辑器会把已发表论文原文作为成果条建议，CV 工作台的就绪检查会提示缺少载体、日期或 DOI / 链接的已发表论文，以及「审稿中」超过 18 个月的论文。站长本人的姓名依据公开的个人信息加粗；尚未发表的论文始终标明真实状态；被隐藏的合著者显示为省略号，作者顺序保持真实。在出现第一篇公开论文之前，网站上不显示任何相关内容（无板块、无导航链接，`/publications` 返回 404）。逻辑位于 `lib/publications/`。

## 连接 ORCID iD

站长的 ORCID iD 是 CV 工作台个人信息里的一个字段（按 ORCID 的 MOD 11-2 校验位检查；粘贴 `https://orcid.org/<id>` 链接会存为纯 iD），同样可用眼睛图标隐藏。填写后按 ORCID 的 iD 展示规范显示——绿色 iD 图标加完整的 `https://orcid.org/<id>` 链接——出现在 `/cv`、`/cv/zh`、`/publications` 与 /about 侧栏，PDF 与纯文本简历中为文字链接，JSON Resume 中为一项 profile，并写入 vCard、Person JSON-LD（`sameAs` 与 ORCID `identifier`，论文作者的 `@id`）和 `/llms.txt` 的一行；隐藏后任何地方都不出现。论文板块的 **Import from ORCID** 会列出该 ORCID 记录的公开作品（由服务器经 ORCID 公共 API 读取，不保存任何内容），标出简历中已有的论文（DOI 或标题相同），勾选的作品作为论文加入，保存前可逐条修改。逻辑位于 `lib/orcid/`。

按 ORCID 的 iD 展示规范：研究者登录 ORCID 证明过的 iD 显示绿色 iD 图标；仅手动填写的 iD 显示「未认证」iD 图标，并在链接后注明 “(unauthenticated)”（中文页面为“（未经认证）”）。CV 工作台 → 个人信息的 iD 字段旁有 **Connect your ORCID iD**，连接后全站显示为已认证。在服务器配置 ORCID 客户端之前，按钮保持禁用：

1. 登录 ORCID（记录需有已验证的邮箱），从账户菜单打开 **Developer Tools**（`https://orcid.org/developer-tools`），接受 Public API 条款，点击 **Register for ORCID Public API credentials**（免费）。名称填网站名，网址填网站地址，描述写明用途（ORCID 会在登录页上显示这些信息）。
2. 按网站实际发送的地址添加 redirect URI：`SITE_URL` 的 origin 加 `/api/admin/orcid/callback`——站点地址为 `https://example.com` 时即 `https://example.com/api/admin/orcid/callback`（ORCID 正式环境只接受 https）。
3. 把 **Client ID**（`APP-...`）与 **Client secret** 写入服务器环境变量 `ORCID_CLIENT_ID`、`ORCID_CLIENT_SECRET` 并重启。想先试用，可在 `https://sandbox.orcid.org/developer-tools` 注册测试客户端（测试记录；那里接受 `http://127.0.0.1:3000/api/admin/orcid/callback` 这类 http 地址，同时把 `SITE_URL` 设为该 origin），并设置 `ORCID_ENV=sandbox`。

工作原理（`lib/orcid/oauth.ts`、`flow.ts`、`connectRoute.ts`）：按钮是指向 `GET /api/admin/orcid/connect` 的普通链接，已登录的管理员被带到 ORCID 的 OAuth 登录页（授权码模式，仅 `/authenticate` 权限，不能访问记录内容），附带一个与当前管理员会话绑定的随机 `state`，保存在签名、一次性、10 分钟有效、HttpOnly、`SameSite=Lax`、仅限回调路径的 Cookie 中。ORCID 把浏览器送回 `GET /api/admin/orcid/callback`；管理员会话 Cookie 是 `SameSite=Strict`，这次跨站跳转不会带上它，因此代理放行这一个接口，由接口自行鉴权：`state` 必须与 Cookie 一致、只能用一次、且发起它的会话仍然有效。服务器在 ORCID 的 token 端点用授权码换取结果（secret 从不到达浏览器；请求经 `safeFetch` 只发往 ORCID 一个主机，不跟随重定向），把确认的 iD 写入两种语言的个人信息并加上标记 `orcidAuthenticated: { id, at }`，记入操作日志，access token 直接丢弃。随后返回一个小页面，以同源跳转打开工作台（Strict Cookie 随之恢复）并弹出提示。ORCID 未为该流程提供 PKCE（其 OpenID 配置没有 `code_challenge_methods_supported`）；机密客户端加会话绑定的 `state` 已覆盖 PKCE 的作用。

标记由服务器掌管：保存时只有简历仍带着同一 iD 的该标记才会保留，所以手动改 iD 即变为未认证（保存前可在工作台撤销），在 JSON 里手写的标记会被忽略。**Disconnect** 只移除标记、保留 iD（显示为未认证）；清空或隐藏字段是普通编辑。公开页面只收到 `{ id }`，且仅在 iD 公开时；PDF、纯文本与 JSON 简历、vCard 和 JSON-LD 始终只写 iD 的 URI。

<img src="../../docs/screenshots/admin-cv-studio.png" width="900" alt="CV 工作台：板块列表、带逐字段眼睛开关的个人信息表单、实时 A4 预览">
