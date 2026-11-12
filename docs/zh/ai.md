# AI 访问：已连接的应用、助手、限额与审计

属于 [Portfolio Studio](../../README.zh.md) · 返回 [AI 协助编辑](../../README.zh.md#ai协助编辑mcp-服务器与自带模型) · 英文版：[docs/ai.md](../ai.md)

本页是 README 摘要背后的运维手册：开关、三个访问级别与每个工具能做什么、用个人令牌或 OAuth 连接应用、助手及其服务商、批准流程、拦住失控模型或被盗令牌的限额，以及审计记录。安全态势见 [SECURITY.md → AI access](../../SECURITY.md#ai-access)（英文）；在本机用合成内容与不需要密钥的脚本化模型试用见 [docs/ai-trial.md](../ai-trial.md)（英文）；贡献者必须守住的代码边界见 [CONTRIBUTING.md → The AI boundary](../../CONTRIBUTING.md#the-ai-boundary-read-this-before-touching-libaitools)（英文）。

## 开启方式

默认关闭。后台 → AI → 连接（Connections）：「AI access」开启助手，「Allow connected apps」开放 `/mcp` 与 OAuth 地址。两者开启时都要再次验证身份；关闭则立即生效、无需验证。关闭会停止正在生成的回答、撤回所有待批准的改动，并让所有 AI 地址的响应与不存在的页面完全一致（状态码、正文与每个响应头）。公开地址还需要设置 `SITE_URL`（MCP 地址与 OAuth 签发者都取自它，从不取自请求），保存模型密钥需要 `AI_KEYS_SECRET`。环境变量 `AI_DISABLED=1` 无论设置如何都会关闭一切，即使 `data/auth.db` 无法读取也一样。开关保存在 `auth.db` 中（`lib/ai/settings.ts`），所以恢复内容不会把它打开。

两个入口共用一套工具、一条批准流程、一份审计记录：

- **已连接的应用**通过本站 `/mcp` 上的 MCP（Model Context Protocol）服务器访问（Streamable HTTP，同时支持 2026-07-28 与 2025-11-25 两版协议，无状态 JSON 响应，仅工具；`pages/api/mcp.ts`、`lib/mcp/server.ts`）：Claude Code、Cursor、VS Code、Codex、Gemini CLI、MCP Inspector，站点公开上线后还有 claude.ai 与 ChatGPT。它们用个人令牌或 OAuth 登录。
- **助手**在后台 → AI 里，用你为某个服务商添加的密钥运行同一套工具：Claude、OpenAI、xAI、OpenRouter、DeepSeek、Gemini、通义千问（Qwen）、Kimi、智谱 GLM、MiniMax、Mistral、Groq、任意兼容 OpenAI 的自定义端点，或本机的 Ollama、LM Studio（`lib/ai/presets.ts` 的 15 个预设）。工具循环在服务器上运行，浏览器只负责显示。

「管理网站」指通过 CMS 管理内容：文章、案例、`/now`、`/uses`、关于页自述、首页、简历、媒体文字、标签、发布、定时、恢复版本、删除与内容健康修复。永远不包括代码、部署、文件、收件箱、访问统计、错误报告、日志、备份、密钥、令牌、会话或设置：这些根本没有对应的工具，批准也无从谈起。

## 访问级别

三个访问级别，三个 OAuth scope，没有通配符，也没有管理员 scope。`tools/list` 只列出该级别允许的工具，越级调用返回 `403 insufficient_scope`：

| 级别 | Scope | 工具数 | 能做什么 |
|---|---|---|---|
| Read published | `content:read` | 8 | `get_site_overview`、`search_content`、`get_content`、`get_home`、`get_cv`、`list_media`、`get_content_health`、`get_authoring_guide`：只读公开视图，与访客看到的文字相同 |
| Read and draft | `+ content:draft` | 14 | 另可读取草稿与待发布修改（`list_versions`、`get_change`、`list_my_changes`），以及三种访客永远看不到的写入：`create_draft`、`edit_content`、`set_media_text` |
| Read, draft and propose | `+ content:propose` | 24 | 另有十种提议：`propose_publishing`、`propose_page_edit`、`propose_home_edit`、`propose_cv_edit`、`propose_tag_change`、`propose_restore`、`propose_content_fix`、`propose_apply_alt`、`propose_media_import`、`propose_delete`。每一项都等你批准 |

助手在你的会话内拥有全部三级，但同样要经过批准。工具在 `lib/ai/tools/*.ts`，注册表在 `lib/ai/registry.ts`（必须与目录一致），`tests/ai-tools.test.ts` 固定了这三个数字。

## 批准

**AI 写的任何内容，未经你批准都不会公开。** 草稿与待发布修改会立即保存并可撤销（在模型（Models）里关闭「Save drafts without asking」后也要先批准）。已定时发布或有有效审阅链接的条目从不被直接修改：它的改动要等待，因为定时任务或链接会把修改带给读者。凡是访客或审阅链接读者可能看到的改动都是提议：服务器保存确切的参数，并据此生成改动卡片——标题、公开视图的完整差异、每个新外链与嵌入及其标记、涉及的公开路径、撤销的范围——从不采用模型的文字，模型的话只作为带标注的引文出现（`lib/ai/changes.ts`、`lib/ai/changeViews.ts`）。批准（后台 → AI → 更改（Changes）、聊天里，或应用给出的审阅链接 `/ai/review/<id>`）是只带 Cookie 的同站请求，并附上所见卡片的哈希；服务器按当前内容重新规划保存的参数，只要有任何不同就什么都不写（「This changed after it was proposed.」；`lib/ai/apply.ts`）。卡片出现在屏幕上满一秒、且指针或焦点在卡片内时，批准按钮才可用（防 DoubleClickjacking）；长差异必须读到末尾；删除还要再次验证身份。`/api/admin/*` 上的 Bearer 令牌会被代理以 `401` 拒绝。待批准的改动 7 天后过期（`WAITING_MS`）；大多数已应用的改动可一键撤销，AI 首次修改前的文档状态保留 90 天。

## 连接应用

后台 → AI → 连接（Connections）为每个客户端提供一个标签页，附准确的配置方法。

- *个人令牌*（`pst_` 前缀）：只显示一次、只存 SHA-256，有效期 7、30、90（默认）或 365 天，只能放在 `Authorization: Bearer` 头里（放在查询串或只放在 Cookie 里的令牌会被拒绝）。创建时需要 2 分钟内的身份验证（`lib/ai/access.ts`、`pages/api/admin/ai/tokens.ts`）。
- *OAuth 2.1*，供会自行登录的客户端使用：在该客户端的标签页按 **Allow a new connection**（为一次连接打开 10 分钟的窗口，外界无法得知窗口是否打开），再从应用里发起连接，并在同意页（`/admin/ai/connect`）上批准——同意页首先显示应用将把你带往的地址。支持客户端 ID 元数据文档与动态注册（`/oauth/register`，无状态，什么都不存），仅 PKCE S256，重定向地址精确匹配，每个响应都带 `iss`；访问令牌 1 小时，刷新令牌每次使用都轮换（超过 10 秒再次使用旧令牌会吊销授权），授权最长 90 天、闲置 30 天即结束（`lib/ai/oauth.ts`、`lib/ai/oauthRoutes.ts`；发现文档是 `/.well-known/oauth-authorization-server` 与 `/.well-known/oauth-protected-resource/mcp`）。来路不明的连接链接会被拦下并说明原因。
- 「Sign out everywhere」、重置密码、修改密码并登出其他浏览器、登出创建该应用的浏览器、吊销或关闭 AI，都会在下一次请求时结束其访问。

## 助手

后台 → AI → **模型（Models）→ Add a model** 列出各服务商；「Check key」读取服务商实时的模型列表（不内置任何列表，也就不会过时），「Test」发送本站完整的工具列表并回传一个工具结果，「Save」加密保存密钥（AES-256-GCM，用 `AI_KEYS_SECRET` 派生的密钥，并绑定服务商与地址，换了地址就无法复用；`lib/ai/secretBox.ts`）。聊天经由代理以服务器推送事件流式显示：Stop（或 Esc）停止回答，刷新页面会接回正在生成的回答，输入法仍在组字时按 Enter 不会发送。回复按白名单渲染：没有图片、没有原始 HTML，只有指向本站页面与编辑器的链接可点击（从不包括 `/api/`、`/oauth/` 或审阅链接），其他地址都是纯文本，点击前不会请求任何东西。同一时间只运行一个回答，每个回答最多 16 步、40 次工具调用、300,000 加权 token（`lib/ai/runBudget.ts`），并受你设定的每日上限约束（默认 2,000,000，最高 20,000,000）。对话只保存在本服务器上，默认 90 天（可选 30 天、保留到删除或不保存）；加密的数据库备份（`lib/storeBackup.ts`）启用后会保存它们的加密副本，但从不包含随对话附上的文件，R2 内容镜像也从不保存它们。只有服务商报告了费用时才显示费用。每个服务商的数据说明就在其密钥旁边。本机服务商（Ollama、LM Studio）需要把精确的回环地址源写进 `AI_LOCAL_PROVIDER_ORIGINS`，且仅当 `SITE_URL` 本身是回环地址时生效。

**文件与语音。** 每条消息最多附 10 个文件，每个不超过 7 MB（代理只克隆 10 MB 以内的请求体）：图片（JPEG、PNG、WebP、GIF）、PDF、UTF-8 文本与代码、WAV 或 MP3 音频——可用「+」添加、拖到页面任意位置、粘贴（截图或复制的文件；粘贴的文字仍是文字）、用摄像头拍照，或截取窗口与屏幕。浏览器先把图片缩到 2048 px、把录音转成 16 kHz 单声道 WAV；服务器（`lib/ai/media.ts`、`POST /api/admin/ai/uploads`）按文件的实际字节检查每个文件，把图片转正并重新编码、去掉全部元数据（没有 GPS、没有相机信息），存进 `ai.db`（`ai_media`）：先归上传它的浏览器会话所有，一天内没有消息认领就删除，被认领后随对话一起删除。`GET /api/admin/ai/media/<id>` 只对管理员提供文件、从不缓存、带沙箱 CSP；文本一律作为 `text/plain` 下载。保存的历史里只有占位符，每次调用模型前才填入文件，所以历史保持小巧、逐字节不变。模型能接收什么，来自 Claude 的 Models API（`image_input`、`pdf_input`）或模型「Test」的文件步骤（一个红色方块、一页只有一个词的 PDF、Chat 线路上的 440 Hz 音调）；已知不接收某类文件的模型永远不会收到这类文件，未知的会先尝试，被拒绝时这条消息与其文件会从对话中移除。文本文件像选中文字一样以数据的形式引用给模型。每个对话的图片、PDF 与音频合计最多 18 MB。来自媒体库的图片标签只会以图片本身发给已知能看图的模型（用于写替代文字）。听写（Web Speech，浏览器支持时在本机识别，否则使用浏览器自己的语音服务）与朗读（speechSynthesis，优先使用本机语音）都在浏览器里进行，从不到达本服务器；语音模式把两者串成免手动的对话。后台页面只为本站开放摄像头、麦克风与屏幕截取（`lib/securityHeaders.js`）。

**在编辑器里问 AI**（⌘J）——文章、案例、页面、首页、简历与媒体编辑器，以及发布检查和内容健康：面板会带上当前文档、选中的文字或用「+ Context」添加的内容。对当前编辑器的修改以建议的形式出现，先显示差异；「Apply to editor」只放进编辑器，保存前什么都不写，保存后记录为 `AI-suggested · <模型> · saved on <浏览器>`（`lib/ai/edits.ts`、`components/Admin/ai/`）。编辑器会标明含有 AI 修改，发布与定时对话框会提示「Contains AI edits」。

## 限额与预算

拦住失控模型或被盗令牌的限额（`lib/ai/budgets.ts`）：每个应用每分钟 60 次请求、每小时 600 次，每分钟 60 次工具调用，每小时 30 次、每天 200 次写入，每天 20 MiB 写入量，最多 50 篇 AI 草稿、10 个待批准改动；每个条目每小时 30 次、每天 100 次 AI 写入；全站每 10 分钟 60 次 AI 写入；登录失败的计数桶（每个客户端与每个网段每 10 分钟 60 次）只在失败时计数。每次写入在保存前都会检查：每次最多 50 处编辑、每处最多 1,000 个匹配，正文最多 256 KiB，不允许远程图片（草稿会让打开它的人去抓取），不允许新增不可见或双向控制字符，frontmatter 走白名单并强制 `draft`，MDX 在限时 3 秒的工作线程里编译（`lib/ai/compileWorker.ts`），恶意结构无法拖垮网站。JSON-RPC 批量请求一律拒绝。

## 审计

每次 AI 写入都先记录、记录失败则拒绝写入（`lib/ai/audit.ts`）；操作日志与版本历史写明执行者（`AI · laptop token`、`AI · DeepSeek · <模型>`，批准则记为 `approved on <浏览器>`）。工具调用（包括读取）在更改（Changes）→「All calls」中保留 30 天，不含发送或返回的内容（`lib/ai/execute.ts`）。对话、改动与调用日志存于 `data/ai.db`（0600、`secure_delete`，从不进入快照或 R2）；开关、令牌、授权与加密后的密钥存于 `data/auth.db`。`scripts/deploy.sh` 会与其他数据库一起备份它们。

## 命令行工具

```bash
node scripts/ai-trial.mjs [--fake-model]   # 在关联的 worktree 中本地试用 AI：只绑定回环地址、合成内容（docs/ai-trial.md）
bash scripts/ai-e2e.sh                     # 在 standalone 服务器上运行 AI 端到端关卡
MCP_CONFORMANCE_TOKEN=<pst_ token> bash scripts/mcp-conformance.sh http://127.0.0.1:<port>   # MCP 一致性测试 + Inspector
node --import ./tests/register.mjs scripts/ai-live-smoke.mjs --real <preset>=<model>   # 真实服务商、真实密钥、真实费用
```

`scripts/ai-e2e.sh [--keep] [--project <name>]... [-- <playwright args>]` 把检出复制到一个临时目录，装入合成数据存储、不带任何 env 文件，构建 standalone 服务器，在回环地址上启动它，旁边运行脚本化测试模型（`tests/helpers/fake-llm.mjs`），然后运行 Playwright 项目 `ai-admin`（Chromium：连接、令牌、经 `/mcp` 写草稿、改动卡片、批准、冲突、二次验证、撤销、助手、在编辑器里问 AI、关闭状态、OAuth）与 `ai-consent-firefox`（Firefox 中的登录与 OAuth 同意页）。需先运行一次 `yarn playwright install chromium firefox`；修改 `lib/ai`、`lib/mcp`、`components/Admin/ai` 或 AI 路由时必须运行。

`scripts/mcp-conformance.sh` 针对开启了 AI 的本地构建与该服务器的一个个人令牌运行（read 级别即可；令牌从环境变量读取、交给回环代理 `scripts/mcp-conformance-proxy.mjs`，从不打印）：`@modelcontextprotocol/conformance` 的 2026-07-28 规范（server-stateless、http-header-validation、caching、dns-rebinding-protection、tools-list、server-sse-multiple-streams）与 2025-11-25 规范（server-initialize、tools-list、ping），外加 authorization-server-metadata-endpoint 场景，与经审阅的基线 `tests/mcp-conformance-baseline.yml` 比对（未列出的失败与过期条目都算失败），然后是 Inspector CLI 的 legacy、auto、modern 三种协议、`--strict` 与 401 路径。请用 bash 运行。`scripts/ai-live-smoke.mjs --real <preset>=<model>` 由站长针对真实服务商运行，密钥来自 `AI_SMOKE_KEY_<PRESET>`；它会产生费用，从来不是关卡。
