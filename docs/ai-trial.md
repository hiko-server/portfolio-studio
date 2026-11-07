# Trying the AI and MCP work locally

`scripts/ai-trial.mjs` runs this branch on your machine, on synthetic content, with nothing
public and nothing that can reach another system. There is no deployment step and no tunnel:
claude.ai and ChatGPT connect from their clouds, so they wait for the first deployment. Claude
Code, Cursor, VS Code, Codex, Gemini CLI, Inspector and the assistant all work locally.

```bash
# Node 22.23.4 first on PATH (.nvmrc). No version manager? The official tarball:
mkdir -p ~/.local/node && curl -fsSL https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-arm64.tar.xz | tar -xJ -C ~/.local/node
export PATH=~/.local/node/node-v22.23.4-darwin-arm64/bin:$PATH

git worktree add ../landing_page-ai-trial feat/ai-mcp
cd ../landing_page-ai-trial && yarn install --frozen-lockfile
node scripts/ai-trial.mjs
```

It builds, serves `http://127.0.0.1:3002` and prints the password once, on the terminal. Use
that URL, not `localhost`. Stop it with Ctrl-C.

| Option | What it does |
|---|---|
| `--dev` | `next dev` instead of a production build, for Safari or hot reload |
| `--port <n>` | Another loopback port |
| `--fake-model` | Also runs the scripted test model (`tests/helpers/fake-llm.mjs`) on the next port, `127.0.0.1:3003` by default, and lets the site reach it as a local provider. It prints how to add it under **Models → Add a model → Custom**. No model runs: it answers what a message asks for (`/say <text>`, `/tool <name> <json>`, `/slow <text>`, `/hostile`) and says so otherwise. No row is added for you and nothing about it is in `lib/`, so the product has no fake mode |
| `--import-content <dir>` | Serves a copy of that checkout's content instead of the fixtures. R2 and mail stay blank, and what the tools read goes to the provider you pick |
| `--check` | Runs every guard, changes nothing, starts nothing |
| `--reset` | Removes `.env.local`, the store, the fixtures and the build, and restores the git seeds. The next run starts fresh with new secrets |
| `--force` | With `--reset` or `--import-content` only: also discards changes under `data/`, `content/` and `public/uploads` that the trial did not make (see below) |

One trial per worktree. While one runs, on any port, every other run refuses, `--import-content` and
`--reset` included, so nothing replaces the store, the secrets or the build under a live server.
`.ai-trial.lock` (git-ignored) names its process, the step it is waiting on (the fixture install,
`next build`), its server and its port, and goes away when it stops. If the script is killed outright
during the build, the build still holds the worktree until it ends. A lock whose processes are gone and
whose port is free is stale and is replaced. Only the lock decides: a server on port 3002 that is not
this worktree's trial (`yarn start` in another checkout, a trial in another worktree) does not stop
`--reset`.

## What keeps it local

A local server edits local data only if R2, SMTP and Cloudflare credentials are absent. With R2
credentials a local save mirrors to whatever bucket they name, and SMTP sends real mail. A null
`getPublicHost()` stops purge and IndexNow, not those two. So:

- **It refuses the main checkout** (`git rev-parse --git-dir` equals `--git-common-dir`), where a
  real `.env.local` may live. It runs only in a linked worktree.
- **It checks Node:** ABI 127 and at least 22.18, and prints the fix otherwise.
- **It reads the env files the way Next does,** with Next's own loader (`@next/env` from this
  worktree's `next`, in a child process), for a production and a development run. So every line Next
  would load counts, in any form Next accepts: `KEY=value`, `KEY: value`, `export KEY=...`, quoted,
  and `${OTHER}` expanded. A file Next cannot read stops the run.
- **It refuses a public host.** A `SITE_URL` or `NEXT_PUBLIC_SITE_HOST` that is not on loopback, in
  the shell or an env file, stops the run. It names the variable, never the value.
- **It blanks credentials** in the server's environment, from the shell and from env files alike:
  `R2_*`, `SMTP_*`, `CF_*`, `INDEXNOW_KEY`, `MONGODB_URI`, `GITHUB_TOKEN`, `ANTHROPIC_*`, `OPENAI_*`,
  and every such name the site or the Claude SDK reads even when nothing set it. Next's env loader
  does not override a set variable, even an empty one. Before it installs or builds anything, the
  script runs that loader on the server's exact environment and stops unless every one of them is
  still empty and the host is on loopback. It prints the names it blanked.
  `LINK_CHECK_INTERVAL_HOURS=0` stops the background link check; **Check links now** still works.
- **The checks run when the trial starts.** `next dev` reloads env files while it runs, so stop the
  trial before you edit one. The credentials the site reads stay blank through a reload either way.
- **It binds to `127.0.0.1` only,** never `0.0.0.0`, and connects to the machine's other addresses
  once the server is up. If one answers, it stops the server.
- **It looks up the provider hosts first.** A proxy in fake-IP mode answers from `198.18.0.0/15`,
  which the site correctly blocks, so providers reached through it would fail. It prints which
  hosts are affected and to switch the proxy to real-IP mode. SSRF rules are never relaxed for this.

`.env.local` is written once, 0600: generated `JWT_SECRET`, `AI_KEYS_SECRET`, `ADMIN_EMAIL`,
`ADMIN_PASS`, plus `SITE_URL` and `ADMIN_RECENT_AUTH_MINUTES=1`, so step-up can be seen a minute after
sign-in. The password is printed once and only on a terminal; captured output never holds it, and it
is always in that file. `ADMIN_EMAIL` and `ADMIN_PASS` set in the shell replace the generated pair, so
an agent can sign in without reading the file.

The fixture store (`scripts/ci/fixture-store.mjs`, "Example Person") is installed if there is no store.
A `content.db` that only a `next build` made from the git seeds counts as none. It replaces
`data/home.json` and `data/cvdata.json` and adds files under `content/`, so `git status` shows them in a
worktree that has run the trial. Commit by file name, never with `git add .`. A store this script did
not install is served as it is.

**It discards only its own changes.** It records what it changed in git's view of `data/`, `content/`
and `public/uploads` (`data/.ai-trial-files.json`, beside the marker `data/.ai-trial-store`). The
fixture install, `--import-content` and `--reset` refuse while those paths hold any other change, an
edited seed or a post not committed yet, or a file the trial wrote and someone changed since. They name
the files and touch nothing. Commit or stash them, or pass `--force` to `--reset` or `--import-content`
to discard them. Ignored files there, the stores in `data/` and the uploads, are the trial's or a
build's, and `--reset` removes them.

The quality gates run with the trial's fixture store in place, so there is no need to `--reset` first;
stop the trial before a build, which replaces `.next` under it. The
unit tests read a local store as the owner's only when the marker does not say `fixture`
(`tests/perf-g7-fixture.test.ts`); a store imported with `--import-content` is the owner's content, and it
is read. The performance budget measures the same on the fixture store as on the git seeds.

## The assistant, with or without a key

Admin → AI opens on the assistant. To try it without spending anything, run with `--fake-model` and add
the test model it prints under **Models → Add a model → Custom** (base URL `http://127.0.0.1:3003/v1`,
Chat Completions, any key, model `fake-model`). **Check key** lists its models, **Test** sends the site's
whole tool list and then the tool's answer back, and **Save** stores the key encrypted (it asks you to
confirm it's you a minute after sign-in). No model runs behind it: a message names what a real model
would do, so you can walk every path of the UI:

| Message | What it shows |
|---|---|
| `/say 你好` | A reply in Chinese, drawn by the allow-list (an Enter that confirms an input method's characters never sends) |
| `/tool create_draft {"collection":"blog","slug":"my-note","frontmatter":{"title":"My note","date":"2026-11-07"},"body":"Hello.","rationale":"A draft."}` | A draft written at once, its card with Undo; visitors see nothing |
| `/tool propose_publishing {"collection":"blog","slug":"my-note","action":"publish","base_version":"<version from the draft's tool row>","rationale":"Publish it."}` | A proposal waiting for you in the chat, approved there or under Changes |
| `/slow <text>` | A long answer: press Stop (or Esc), or reload the page mid-answer and watch it re-attach |
| `/hostile` | Images, raw HTML and links to `/api/` shown as text: nothing is fetched |

Turning AI access off in Connections while an answer is being written stops it, withdraws every change
still waiting and makes `/mcp` a plain 404 again. With a real key (a dedicated one with a low spend
limit), the same steps run on your provider; Ollama works with `AI_LOCAL_PROVIDER_ORIGINS=http://127.0.0.1:11434`
in the worktree's `.env.local`.

## The full trial, step by step

Every step and check below was walked by an agent on 2026-11-07 against a production build of this branch
(`node scripts/ai-trial.mjs --fake-model --port 3780`, Chromium through Playwright, the scripted test model
standing in for a real one), and each line says what it saw. **Your part** says what only you can do: a real
key, a real client, your own Claude config. Tick the boxes as you go. Where a step says "a message", type it in
Admin → AI; with a real model, say it in your own words instead (the slash forms are for the test model only).

Start it the way you will use it: `node scripts/ai-trial.mjs` (add `--fake-model` to begin without a key). Sign
in at `http://127.0.0.1:3002` with `ADMIN_EMAIL` and `ADMIN_PASS` from `.env.local`. Step-up asks again a
minute after each sign-in or confirmation, so you will see it often; that is the point.

| # | Do | You should see | Agent walk | Your part |
|---|---|---|---|---|
| 1 | `curl -si -X POST http://127.0.0.1:3002/mcp` | `404`, exactly what an unknown path answers | ✅ 404; same status, body and header names as `POST /zz-not-a-page` | ☐ the same `curl` |
| 2 | Wait a minute after sign-in. Admin → AI → Connections: turn on **AI access**, then **Allow connected apps**. `curl` again | "Confirm it's you" for AI access; then `401` with `WWW-Authenticate: Bearer … resource_metadata="…/.well-known/oauth-protected-resource/mcp"` | ✅ asked after 62 s; `401` with `resource_metadata` | ☐ |
| 3 | **New token** → *Read published* → Create (it asks again: a token needs a confirmation within 2 minutes). `MCP_CONFORMANCE_TOKEN=<token> bash scripts/mcp-conformance.sh http://127.0.0.1:3002` | The token once (`pst_…`, 43 characters), never again on the page; the conformance summary all `ok` | ✅ token shown once and absent from what the page reads back; conformance exactly as in the next section | ☐ run it with your token |
| 4 | `npx -y @modelcontextprotocol/inspector@2.12.0 --cli http://127.0.0.1:3002/mcp --transport http --header "Authorization: Bearer $T" --method tools/list --format json` | Exit 0, 8 tools | ✅ exit 0, the 8 read tools | ☐ |
| 5 | **Claude Code** (this writes your Claude config): `claude mcp add --transport http --scope local site-local http://127.0.0.1:3002/mcp --header "Authorization: Bearer $T"`, ask "What's on my site?", then `claude mcp remove site-local` | Claude Code answers from the site; the token's row in Connections says it was used and what the client calls itself | ✅ stand-in: a client that names itself made a legacy `initialize` and a `get_site_overview` call; the row read "says it is “Example MCP client” · last used just now" | ☐ **Claude Code itself** (your config and login) |
| 6 | Make a *Read and draft* token; ask your client to draft a post | The draft in Admin → Posts; `/blog`, `/feed.xml`, `/sitemap.xml`, `/llms.txt` unchanged; the post's address 404 | ✅ draft for the owner; the four public files byte-identical; 404 | ☐ with your client |
| 7 | Ask it to edit a published post | Saved as unpublished changes; visitors read the published text | ✅ `unpublished_changes`; the public page unchanged | ☐ |
| 8 | Schedule that draft yourself (Publish… → Schedule…), ask it to edit the draft again | `ITEM_SCHEDULED`; nothing changes | ✅ `ITEM_SCHEDULED`; the version unchanged | ☐ |
| 9 | Make a *Read, draft and propose* token; "Publish it". Open the review link from another app (a link on another site) | A card: what goes live, the whole diff, new links with their flags, the model's words as a quote. No sign-in page in between. Approve is off until the card has been on screen a second with your pointer in it. `Published`; the page is live; Undo puts it back | ✅ all of it: the review link went `/ai/review/<id>` → `/admin/ai/change/<id>` with no `/admin/login`; Approve off, then armed; live (200); Undo → 404, the app reads `undone` | ☐ |
| 10 | Propose a page edit, edit that page yourself in another tab, then approve | `This changed after it was proposed.` Nothing overwritten; the app reads `conflict` (an assistant conflict offers **Ask again**) | ✅ conflict; your line kept, the proposal not written | ☐ |
| 11 | Propose deleting a draft; approve it more than a minute after your last confirmation | "Confirm it's you", then the delete | ✅ asked, then applied | ☐ |
| 12 | **Add a model**: Models → Add a model → your provider → Check key → pick a model → Test → Save. Use a dedicated key with a low spend limit (Ollama: `AI_LOCAL_PROVIDER_ORIGINS=http://127.0.0.1:11434` in `.env.local`) | The provider's live model list; Test `Ready` (the site's whole tool list went out and the tool's answer came back); the row Ready, the key never shown again | ✅ with the test model: 4 models listed; Ready (25 tools sent, the replay carried the tool result); Saved | ☐ **with your real key** (see below) |
| 13 | In the assistant: chat in Chinese; "Draft a post about X"; "Publish it" and approve in the chat; Stop (Esc) a long answer; reload during another | An Enter that confirms Pinyin characters never sends; a draft card, then a proposal card, neither taking the focus; Stopped; the answer re-attaches after the reload and every word arrives once | ✅ composition Enter sent nothing (simulated composition events); `zh-Hans` reply; both cards, focus kept; approved → live; "Stopped."; 40 of 40 words after the reload | ☐ with a real model and your own input method |
| 14 | While an answer is written, turn AI access off in Connections (another tab) | The answer ends "AI access was turned off."; every waiting change withdrawn on its card; `/mcp` 404; the box says AI access is off | ✅ all four (also an e2e test, `@ai off`) | ☐ |
| 15 | **Claude Code over OAuth**: remove the header (`claude mcp remove site-local`, add it back without `--header`); in Connections open the *Claude Code* tab and press **Allow a new connection**; run `/mcp` in Claude Code; on the consent page raise the level to *Read, draft and propose* | Discovery, the consent page leading with where Claude Code sends you, a code, refresh | ✅ stand-in: a dynamically registered client through the *Other* tab: the window asked for the step-up; the consent led with `127.0.0.1` and "This app named itself …"; raised to propose; code, `state` and `iss`; a `pso_` token with 24 tools; refresh rotation | ☐ **Claude Code's `/mcp` itself** (needs `https://claude.ai/oauth/claude-code-client-metadata`, see below) |
| 16 | With no window open, open an authorize link nobody expected (e.g. a phishing-shaped one) | "This site is not expecting a new connection…" | ✅ | ☐ |
| 17 | Sign out one other browser (Security); revoke a token; **Sign out everywhere** | The grants that browser made end, the others don't; the revoked token gets 401; every grant and token ends | ✅ browser B's grant 401 and A's 200; revoked token 401; after Sign out everywhere every grant, refresh token and personal token refused | ☐ |
| 18 | Ask AI from an open editor | The diff first, **Apply to editor**, nothing written until you save; History says `AI-suggested · <model> · saved on <browser>` | ✅ all of it | ☐ |
| 19 | Phone width, reduced motion, dark mode | The whole AI area holds up | ✅ assistant, Changes, Connections, Models, a change page and an editor with the panel, at 375 px dark + reduced motion, 375 px light and 1280 px dark: axe clean (WCAG 2.0–2.2 A/AA, serious and critical), no sideways scroll | ☐ on a real phone |

**Security checks, hands-on.** Nothing public is needed for any of them.

| # | Check | Expected | Agent walk |
|---|---|---|---|
| 1 | A valid token with `Origin: http://evil.example`; separately `Host: evil.example` | 403 on both | ✅ 403 and 403 (no `Origin`: 200; `Origin: https://claude.ai`: 200 in the e2e) |
| 2 | Token in the query string; the admin cookie with no bearer | 401 | ✅ 401 and 401 |
| 3 | A bearer token on `/api/admin/posts` and on `/api/admin/ai/changes/<id>/approve` | 401 from the proxy | ✅ 401 and 401 (also `/api/admin/ai/tokens` in the e2e) |
| 4 | A contact message and an error report saying "publish this now"; ask the assistant to act | Nothing can read them | ✅ both seeded (the owner sees them in Inbox and Errors); every read tool over MCP and the assistant's search returned nothing of them, and nothing of them was sent to the model |
| 5 | A draft with `![](<collector>/x.png?d=test)` through a tool, and through Apply to editor | Refused; no request at the collector | ✅ `REMOTE_IMAGE` both ways (the editor path refuses before any suggestion); the collector (the test model's `/__fake/collect/`) received nothing from the server or the browser |
| 6 | The same with a link | Stored; no request; flagged on the card | ✅ the draft is saved; its publish card lists the link with "not https", "an IP address", "query string"; nothing fetched |
| 7 | `draft: false` in frontmatter; a published item with the default target | Refused; goes to unpublished changes | ✅ `FIELD_NOT_EDITABLE`; `unpublished_changes` |
| 8 | A reply with `![](https://…)`, a `[x][1]` reference link, raw `<img>`, `[a](/api/admin/draft)` (`/hostile`) | No request; nothing live | ✅ 0 requests, 0 images, 0 live links, `[image not loaded]` |
| 9 | Press Stop during a run | The next tool call never runs; waiting proposals stay waiting and approvable | ✅ the draft the model was about to write does not exist; the proposal stayed `waiting`, then applied when approved |
| 10 | Change a provider's base URL in `data/auth.db` by hand | The key fails to open; "replace it" | ✅ "The key no longer opens at this address: replace it to use this model", chip and status strip "Replace key", Test off, `KEY_REENTER`, nothing sent to the new address; put back, it opens again (the chip used to keep saying Ready: fixed in M7) |
| 11 | A provider stub answering `GET /models` with a 302 | No `Authorization` sent onward | ✅ the key went to the stub only; nothing followed the redirect |
| 12 | `AI_LOCAL_PROVIDER_ORIGINS` with a public `SITE_URL` | Ignored; System health warns | ✅ on the server's own functions with `SITE_URL=https://www.example.com` (the trial refuses to serve a public host, by design): no local origin admitted, and the warning. Also `tests/ai-settings.test.ts` |
| 13 | Base URL `http://169.254.169.254/` and `https://[::a9fe:a9fe]/` | Refused | ✅ "Use an https address." and "Use a host name, not an IP address." (`safeFetch` refuses those ranges anyway) |
| 14 | A refresh token used twice | Within 10 s refused only; past 10 s the grant is revoked, mail attempted | ✅ both; revoke reason "refresh token used twice"; the trial log shows the owner mail attempted ("SMTP not configured, message skipped") |
| 15 | `/oauth/authorize` with a bad scope and an unknown client, no window; the same with a window | The same bounce both times; the error on our page behind the session; no redirect | ✅ byte-identical bounces; `invalid_scope` behind the session, 401 without it |
| 16 | PKCE `plain`; no challenge; a verifier without a challenge | All refused | ✅ `invalid_request`, `invalid_request`, `invalid_grant` |
| 17 | 60 identical writes in a loop | Stopped by the loop guard and the per-item cap; the earliest before-state survives | ✅ over MCP: 1 saved, the stale repeats conflict, the app's write budget stops them from the 31st and the request rate (60 a minute) the rest; another app is stopped by the per-item cap (`itemWritesHour`); the first change keeps the pre-AI state and its Undo restored it. In the assistant: the same write twice in one answer → `LOOP_STOPPED` and the answer stops |
| 18 | A sentinel key: grep responses, stdout, the log buffer, the error store | Absent | ✅ absent from 205 admin responses the browser read, the server's whole log, System and Errors |
| 19 | 40 doubling edits; a 256 KB `[a](` body; a JSON-RPC array of 100 | `EDIT_TOO_LARGE`; `MDX_TOO_COMPLEX` with public pages still answering; 400 | ✅ all three; public pages answered in 7 ms during the compile; none of the 100 calls ran |
| 20 | Propose `apply_alt`, then `set_media_text` with other words, approve the old card | `conflict`; nothing written | ✅ |
| 21 | Hide a CV entry after `get_cv`; `remove_entry` with its uid | `NOT_FOUND`, as for an unknown uid; the stored CV unchanged | ✅ |
| 22 | A real browser through the whole consent flow, Chromium and Firefox | The redirect works; no CSP violation | ✅ Chromium and Firefox 155 (Playwright's), from a link on another site, no enforced CSP violation; also `e2e/ai-oauth.spec.ts` in both projects |

No console error or page error in any admin page walked, apart from the browser's own log lines for the
deliberate refusals above (a 409 conflict, a 403 step-up, a refused key check, a 404 probe).

### The automated runs at the end of M7

- `bash scripts/mcp-conformance.sh` against the trial with a *Read published* token: spec 2026-07-28
  `server-stateless` 24/28 (the 4 baseline entries), `http-header-validation` 14/14, `caching` 4/7 (the 3 baseline
  entries), `dns-rebinding-protection` 2/2, `tools-list` 4/4, `server-sse-multiple-streams` 1/1; spec 2025-11-25
  `server-initialize` 2/2, `tools-list` 3/3, `ping` 2/2; `authorization-server-metadata-endpoint` 2/2; Inspector
  legacy, auto and modern 8 tools, `--strict` exit 0, `--stored-auth-only` without a token exit 3. With a *Read,
  draft and propose* token Inspector lists the 24 tools and `--strict` passes on the whole list.
- `bash scripts/ai-e2e.sh`: `ai-admin` 45 passed, `ai-consent-firefox` 7 passed (the standalone server).

### What needs a real key or a real client (yours to try)

- **Your provider, with a real key** (step 12–14 again): a dedicated key with a spend limit. To see what each
  provider really does before you rely on it, `node --import ./tests/register.mjs scripts/ai-live-smoke.mjs --real
  <preset>=<model>` with the key in `AI_SMOKE_KEY_<PRESET>` (it costs a few requests). Unverified here: Gemini's
  `extra_content` round trip, Alibaba (Qwen) tools with streaming and its per-region addresses, Mistral, Groq and
  MiniMax stream shapes, Kimi's `strict` default, LM Studio and vLLM reasoning, a zero-argument tool everywhere,
  China hosts, and whether your Anthropic account enforces the prompt prefix.
- **A real input method** in the box (macOS Pinyin): the e2e and the walk drive the composition events browsers
  send, not the OS input method.
- **Claude Code** (steps 5 and 15): its `/mcp` is a terminal UI using your own config and login. Over OAuth the
  site fetches `https://claude.ai/oauth/claude-code-client-metadata`; if your proxy runs in fake-IP mode
  (`198.18.0.0/15`), the site correctly refuses that answer — switch the proxy to real-IP mode first (the trial's
  preflight names affected hosts).
- **Cursor, VS Code, Codex, Gemini CLI**: each tab in Connections shows its setup; none was run here.
- **claude.ai and ChatGPT**: only at the first deployment (they connect from their clouds; there is no tunnel). Also
  then: the exact client and redirect pairs for `lib/ai/knownClients.ts`, popups and COOP, the `Origin` and eras they
  send, ChatGPT plan gating, and Cloudflare (Bot Fight Mode cannot be skipped per path; the AI Agent policy).
- **Owner alert mail**: the trial has no SMTP, so mails are attempted and logged as skipped.
- **Safari** (it rejects the `Secure` cookie on plain http; use `--dev`), **real phones**, and the **1 GB container**
  (Docker was not running here: `scripts/check-container.sh` is for the deployment).

### Before any later deployment, not now

Add `AI_KEYS_SECRET` to the server's `.env` (an env-only change: backup, then `docker compose up -d
--force-recreate`), check `SITE_URL` is set there, check Cloudflare's Bot Fight Mode and AI Agent policy, run
`scripts/cloudflare-config.mjs` and `scripts/check-container.sh`, and from outside the network the `curl` list for
`/mcp`, the discovery documents and the closed state.

## Browsers on plain `http://127.0.0.1`

The session cookie is `Secure` in a production build, so whether a browser signs in at all depends on
how it treats `Secure` on loopback.

| Browser | Build mode | Evidence |
|---|---|---|
| Chromium | Works | `e2e/ai-signin.spec.ts` in project `ai-admin` |
| Firefox | **Works** | The spike of stage P0: Firefox 155.0 (Playwright's build 1543), `e2e/ai-signin.spec.ts` in project `ai-consent-firefox`, 2026-11-06, on `next start` and on the standalone server. Firefox stores the `Secure`, `HttpOnly` session cookie on `http://127.0.0.1` and sends it back |
| Safari | Rejects the cookie | Known, not re-tested here. Use `--dev`, where the cookie is not `Secure` |

So: Chrome or Firefox in build mode, `--dev` for Safari.

**If Playwright's Firefox quits with `Could not find profile folder`:** Firefox reads the profile list in
`~/Library/Application Support/Firefox` even when it is given a `-profile`, and macOS can deny that folder
to the calling process (an agent's shell, here; `ls` on it answers `Operation not permitted`). The
`ai-consent-firefox` project sets `CFFIXED_USER_HOME` to an empty temp directory for that one browser
process, so it runs either way and your Firefox data is never read. Firefox used by hand is not affected.

## The automated version

`scripts/ai-e2e.sh` proves what `next start` cannot, the standalone server the image runs. It copies this
checkout to a temp tree, without any env file (git ignores only `.env` and `.env*.local`, and a build
would load `.env.production` and copy it next to the standalone server), installs the fixtures, builds,
starts the standalone server and `tests/helpers/fake-llm.mjs` on loopback with throw-away secrets, and
runs the Playwright projects `ai-admin` (Chromium) and `ai-consent-firefox`. Prerequisite, once:
`yarn playwright install chromium firefox`.

Those two projects exist only in that script's runs: it sets `E2E_FAKE_LLM_URL`, and without it
`e2e/playwright.config.ts` does not register them. A plain `yarn e2e`, and the post-deploy run against
the live site, never list an AI test. With the variable set, the config refuses any `E2E_BASE_URL` or
fake that is not on `127.0.0.1`.
