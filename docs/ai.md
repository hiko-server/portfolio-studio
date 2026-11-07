# AI access: connected apps, the assistant, limits and audit

Part of [Portfolio Studio](../README.md) · back to [AI: an MCP server and your own model](../README.md#ai-an-mcp-server-and-your-own-model)

This page is the operator manual behind the README's summary: the switches, the three access levels and what each tool may do, connecting an app with a personal token or OAuth, the assistant and its providers, the approval path, the limits that stop a runaway model or a stolen token, and the audit trail. The security posture is in [SECURITY.md → AI access](../SECURITY.md#ai-access); a local trial with synthetic content and a scripted model that needs no key is in [docs/ai-trial.md](ai-trial.md); the code boundary a contributor must keep is in [CONTRIBUTING.md → The AI boundary](../CONTRIBUTING.md#the-ai-boundary-read-this-before-touching-libaitools).

## Turning it on

Off by default. Admin → AI → Connections → *AI access* turns the assistant on; *Allow connected apps* opens `/mcp` and the OAuth addresses. Both ask you to confirm it's you; turning either off is instant and never asks. Off stops any answer being written, withdraws every change still waiting and makes every AI address answer exactly what an unknown page answers (status, body and every header). The public addresses also need `SITE_URL` (the MCP address and the OAuth issuer come from it, never from the request), and model keys need `AI_KEYS_SECRET`. `AI_DISABLED=1` in the environment turns everything off whatever the settings say, even with `data/auth.db` unreadable. The switches live in `auth.db` (`lib/ai/settings.ts`), so a content restore cannot turn them on.

Two ways in share one set of tools, one approval path and one audit trail:

- **Connected apps** reach the site's MCP (Model Context Protocol) server at `/mcp` (Streamable HTTP, both the 2026-07-28 and the 2025-11-25 protocol, stateless JSON responses, tools only; `pages/api/mcp.ts`, `lib/mcp/server.ts`): Claude Code, Cursor, VS Code, Codex, Gemini CLI, the MCP Inspector, and once the site is public, claude.ai and ChatGPT. They sign in with a personal token or OAuth.
- **The assistant** in Admin → AI runs the same tools on a key you add for a provider: Claude, OpenAI, xAI, OpenRouter, DeepSeek, Gemini, Qwen, Kimi, GLM, MiniMax, Mistral, Groq, a custom OpenAI-compatible endpoint, or a local Ollama or LM Studio (the 15 presets of `lib/ai/presets.ts`). The server runs the tool loop; the browser only shows it.

"Manage the site" means its content through the CMS: posts, case studies, `/now`, `/uses`, the About bio, home, CV, media texts, tags, publishing, scheduling, restoring versions, deleting and content-health fixes. Never code, deploys, files, the inbox, analytics, error reports, logs, backups, keys, tokens, sessions or settings: no tool exists for them, approved or not.

## Access levels

Three access levels, three OAuth scopes, no wildcard and no admin scope. `tools/list` shows only what the level allows, and a call above it answers `403 insufficient_scope`:

| Level | Scopes | Tools | What it can do |
|---|---|---|---|
| Read published | `content:read` | 8 | `get_site_overview`, `search_content`, `get_content`, `get_home`, `get_cv`, `list_media`, `get_content_health`, `get_authoring_guide`: the public view only, the same text visitors read |
| Read and draft | `+ content:draft` | 14 | Also drafts and unpublished changes (`list_versions`, `get_change`, `list_my_changes`), and three writes visitors never see: `create_draft`, `edit_content`, `set_media_text` |
| Read, draft and propose | `+ content:propose` | 24 | Also ten proposals: `propose_publishing`, `propose_page_edit`, `propose_home_edit`, `propose_cv_edit`, `propose_tag_change`, `propose_restore`, `propose_content_fix`, `propose_apply_alt`, `propose_media_import`, `propose_delete`. Each one waits for you |

The assistant holds all three, inside your session; approvals still apply. The tools are `lib/ai/tools/*.ts`, the registry `lib/ai/registry.ts` (which must equal the catalogue), and `tests/ai-tools.test.ts` pins the three counts.

## Approval

**Nothing an AI writes goes public until you approve it.** A draft or unpublished changes are saved at once with Undo (or wait for you too, with *Save drafts without asking* off in Models). An item that is scheduled or has an active review link is never edited directly: its change waits, because a schedule or a link would carry it to readers. Everything visitors or review-link holders could see is a proposal: the server stores the exact arguments and builds the change card from them — title, full diff of the public view, every new external link and embed with flags, the public paths it touches, Undo's reach — never from model text, which appears only as a labelled quote (`lib/ai/changes.ts`, `lib/ai/changeViews.ts`). Approving (Admin → AI → Changes, the chat, or the review link `/ai/review/<id>` an app shows you) is a same-site, cookie-only request carrying the hash of the card you saw; the server re-plans the stored arguments against the content as it is now and writes nothing if anything differs (*This changed after it was proposed.*; `lib/ai/apply.ts`). Approve is armed only after the card has been on screen a second with the pointer or focus inside it (DoubleClickjacking), stays off until a long diff has been read to its end, and a delete asks you to confirm it's you. A bearer token on any `/api/admin/*` route gets `401` from the proxy. Waiting changes expire after 7 days (`WAITING_MS`); most applied ones have one-click Undo, and the state before AI first touched a document is kept for 90 days.

## Connecting an app

Admin → AI → Connections has a tab per client with its exact setup.

- *Personal token* (`pst_` prefix): shown once, stored as SHA-256 only, for 7, 30, 90 (default) or 365 days, sent only as `Authorization: Bearer` (a token in the query string or a cookie alone is refused). Making one needs a verification within the last 2 minutes (`lib/ai/access.ts`, `pages/api/admin/ai/tokens.ts`).
- *OAuth 2.1*, for clients that sign in by themselves: press **Allow a new connection** in that client's tab (it opens a 10-minute window for one connection, and nothing public can tell whether one is open), start the connection from the app, and approve it on the consent page (`/admin/ai/connect`), which leads with where the app will send you. Client ID metadata documents and dynamic registration (`/oauth/register`, stateless: nothing is stored), PKCE S256 only, exact redirect URIs, `iss` on every response, access tokens for 1 hour, refresh tokens that rotate on each use (a reused one past 10 seconds revokes the grant), grants for 90 days that end after 30 days unused (`lib/ai/oauth.ts`, `lib/ai/oauthRoutes.ts`; the discovery documents are `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`). A link nobody expected bounces to a page that says so.
- *Sign out everywhere*, a password reset or change with sign-out, signing out the browser that made an app, revoking it or turning access off end its access on the next request.

## The assistant

Admin → AI → **Models → Add a model** lists the providers; *Check key* reads the provider's live model list (nothing is bundled, nothing goes stale), *Test* sends the site's whole tool list and a tool answer back, *Save* seals the key (AES-256-GCM under a key derived from `AI_KEYS_SECRET`, bound to its provider and address, so a changed address cannot reuse it; `lib/ai/secretBox.ts`). The chat streams over server-sent events through the proxy: Stop (or Esc) ends an answer, a reload re-attaches to the one being written, and Enter while an input method is composing never sends. Replies are drawn by an allow-list: no images, no raw HTML, and only links to the site's own pages and editors are live (never `/api/`, `/oauth/` or a review link); every other address is plain text, and nothing is fetched before a click. One answer at a time, at most 16 model steps, 40 tool calls and 300,000 weighted tokens each (`lib/ai/runBudget.ts`), under a daily limit you set (default 2,000,000, at most 20,000,000). Conversations stay on this server for 90 days by default (30, until deleted, or *Don't keep*), never in a backup or the R2 mirror. Cost shows only when a provider reports it. Each provider's data notice sits next to its key. Local providers (Ollama, LM Studio) need their exact loopback origin in `AI_LOCAL_PROVIDER_ORIGINS`, honoured only while `SITE_URL` is itself a loopback address.

**Ask AI from the editors** — the post, case-study, page, home, CV and media editors, the publish sheet's checks and content health (⌘J): the panel takes the open document, a selection or anything added with *+ Context*. A change to the open editor arrives as a suggestion with its diff first; *Apply to editor* puts it in the editor and nothing is written until you save, which is then recorded as `AI-suggested · <model> · saved on <browser>` (`lib/ai/edits.ts`, `components/Admin/ai/`). The editor shows that it holds AI edits, and the publish and schedule dialogs say *Contains AI edits*.

## Limits and budgets

Limits that stop a runaway model or a stolen token (`lib/ai/budgets.ts`): per app 60 requests a minute and 600 an hour, 60 tool calls a minute, 30 writes an hour and 200 a day, 20 MiB of writes a day, 50 AI-made drafts, 10 waiting changes; per item 30 AI writes an hour and 100 a day; 60 AI writes per 10 minutes site-wide; a failed-sign-in bucket (60 per 10 minutes per client and per network) charged only on failure. Every write is checked before it is stored: at most 50 edits and 1,000 matches per edit, bodies up to 256 KiB, no remote images (the draft would fetch them for whoever opens it), no invisible or bidi control characters added, frontmatter from an allow-list with `draft` forced, and the MDX compiled in a worker with a 3-second wall clock (`lib/ai/compileWorker.ts`), so hostile structure cannot stall the site. JSON-RPC batches are refused.

## Audit

Every AI write is recorded before it happens and refused when the record cannot be written (`lib/ai/audit.ts`); Activity and the version history name the actor (`AI · laptop token`, `AI · DeepSeek · <model>`, approvals as `approved on <browser>`). Tool calls, reads included, are listed for 30 days under Changes → *All calls*, without what was sent or returned (`lib/ai/execute.ts`). Conversations, changes and the call log live in `data/ai.db` (0600, `secure_delete`, never in a snapshot or R2); the switches, tokens, grants and sealed keys in `data/auth.db`. Both are copied by `scripts/deploy.sh` with the other stores.

## Command-line tools

```bash
node scripts/ai-trial.mjs [--fake-model]   # local AI trial in a linked worktree: loopback, synthetic content (docs/ai-trial.md)
bash scripts/ai-e2e.sh                     # AI end-to-end gate on the standalone server
MCP_CONFORMANCE_TOKEN=<pst_ token> bash scripts/mcp-conformance.sh http://127.0.0.1:<port>   # MCP conformance + Inspector
node --import ./tests/register.mjs scripts/ai-live-smoke.mjs --real <preset>=<model>   # real providers, real keys, real cost
```

`scripts/ai-e2e.sh [--keep] [--project <name>]... [-- <playwright args>]` copies the checkout to a temp tree with the fixture store and no env file, builds the standalone server, starts it on loopback next to the scripted model (`tests/helpers/fake-llm.mjs`), and runs the Playwright projects `ai-admin` (Chromium: connections, tokens, drafts over `/mcp`, the change card, approval, conflict, step-up, Undo, the assistant, Ask AI, the closed state, OAuth) and `ai-consent-firefox` (sign-in and the OAuth consent in Firefox). It needs `yarn playwright install chromium firefox` once and is required for changes under `lib/ai`, `lib/mcp`, `components/Admin/ai` or the AI routes.

`scripts/mcp-conformance.sh` runs against a local build with AI on and a personal token of that server (read level is enough; the token is read from the environment, handed to the loopback proxy `scripts/mcp-conformance-proxy.mjs` and never printed): `@modelcontextprotocol/conformance` for the 2026-07-28 spec (server-stateless, http-header-validation, caching, dns-rebinding-protection, tools-list, server-sse-multiple-streams) and the 2025-11-25 spec (server-initialize, tools-list, ping) plus the authorization-server-metadata-endpoint scenario, compared with the reviewed baseline `tests/mcp-conformance-baseline.yml` (an unlisted failure and a stale entry both fail), then the Inspector CLI in the legacy, auto and modern eras, `--strict`, and the 401 path. Run it with bash. `scripts/ai-live-smoke.mjs --real <preset>=<model>` is owner-run against real providers with keys from `AI_SMOKE_KEY_<PRESET>`; it costs money and is never a gate.
