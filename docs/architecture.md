# Architecture: stores, migrations, request path, routes, layout, tests

Part of [Portfolio Studio](../README.md) · back to [Architecture](../README.md#architecture)

This page is for whoever changes the code: how a request travels, where content lives and how it is written, how the five SQLite stores are migrated, every public route with the handler behind it, the project layout and the test suites. Every claim names the file that holds it.

## Content store (local-first)

```text
                ┌─────────────┐
   admin GUI ──▶│ /api/home   │──┐
                │ /api/admin/*│  │ dual-write
                └─────────────┘  │
                                 ▼
            ┌──────────────────────────────┐
            │ SQLite (data/content.db)     │  ← canonical
            └──────────────────────────────┘
                                 │ best-effort
                                 ▼
            ┌──────────────────────────────┐
            │ Cloudflare R2                │  ← off-site mirror
            │ pages/*.mdx, blog/, work/,   │
            │ data/*.json, uploads/,       │
            │ backups/snapshot-<UTC>.tgz   │
            └──────────────────────────────┘
```

`lib/contentStore.ts` is the dual-write store; `lib/db.ts` opens `data/content.db` (tables `pages`, `collection_items`, `kv`, `r2_pending`, plus the editorial and media tables of migrations 002 and 003) and `lib/r2.ts` talks to the mirror.

- **Read order**: SQLite first; a missing row is filled from the git seed (`data/home.json`, `data/cvdata.json`; `content/blog/` and `content/work/` hold only `.gitkeep` in the repository) and the seed is written into the store. Seeds never overwrite: a row that exists but cannot be parsed is reported and treated as absent for readers, never replaced by the stale seed.
- **Write order**: the synchronous SQLite write must succeed (errors propagate; multi-statement writes run in one transaction). The R2 push follows when R2 is configured, retried with backoff (`R2_TIMEOUTS` in `lib/r2.ts`: 5 s to connect, 10 s per request, 3 attempts); when it still fails the local write stands, the caller gets `r2Warning`, and the key is recorded in `r2_pending` so the next boot re-uploads or re-deletes it from the local row instead of trusting timestamps.
- **R2 key layout** mirrors a file tree so any S3 browser can inspect it: `pages/*.mdx`, `blog/*.mdx`, `work/*.mdx`, `data/*.json`, `uploads/*`, `backups/*.tgz`.
- **Container boot** runs `scripts/sync-from-r2.mjs` before the server starts: pending keys first, then the newer side wins by real timestamps (R2 `LastModified` against the row's `updated_at`). Exit 0 means synced or R2 not configured; 3 means R2 failed but the local content is intact, so the site serves it; 1 means nothing to serve (or `R2_REQUIRED=1` without R2), and the container refuses to start an empty site (`docker-entrypoint.sh`).

Five stores live under `data/`: `content.db`, `analytics.db` (page views, Web Vitals, goal events, errors, restore-drill results), `auth.db` (sessions, passkeys, review links, CV share links, AI settings, tokens and grants), `audit.db` (the activity log) and `ai.db` (conversations, changes, the call log). The last three are kept at mode 0600 (`scripts/migrate-db.mjs`). `data/content.db` is canonical; the git seeds are a one-way bootstrap; R2 is a mirror that boot reconciles. One admin account per deployment (`lib/admin.ts`); there is no multi-tenancy.

## Versioned SQLite migrations

Every store (`content.db`, `analytics.db`, `auth.db`, `audit.db`, `ai.db`) has an ordered list of migration modules in `scripts/db/<store>/NNN-name.mjs`, listed by `scripts/db/<store>/index.mjs` and applied by `scripts/db/migrate.mjs`, which the app and the plain-Node boot scripts share. Today: content 3 (`001-baseline`, `002-editorial`, `003-media-library`), analytics 7 (`001-baseline` to `007-explore`), auth 5 (`001-passkeys-sessions` to `005-ai-access`), audit 2 (`001-baseline`, `002-ai-actor`), ai 2 (`001-baseline`, `002-change-issuer-session`).

A migration is `{ version, name, up(db) }`; versions start at 1 and are contiguous. Each one runs in its own `BEGIN IMMEDIATE` transaction together with its row in `schema_version` (mirrored in `PRAGMA user_version`), so it applies completely or not at all, exactly once even when several processes open the store together (`next build` workers, the boot sync and the server). Version 1 of every store is a baseline written with `CREATE ... IF NOT EXISTS`, so a store that predates the runner adopts it without a change to its tables.

Migrations run when a store opens and at server start (`instrumentation.ts`); a store that is already versioned is copied aside with `VACUUM INTO` under `data/backups/pre-migration/` (newest 5) before a new step touches it. Only additive changes are allowed — add tables, nullable or defaulted columns and indexes; never drop, rename or retype in the release that stops using something — because `scripts/deploy.sh` rolls back by starting the previous image on the same data volume, and an older image that meets a newer store logs a warning and keeps working. `yarn db:status` shows each store's version; the operator runbook is in [docs/operations.md → Migrations](operations.md#migrations).

## Request path and ISR

`proxy.ts` is Next 16's proxy (the former middleware); it runs on the Node.js runtime in the server process before any page or API route, with five responsibilities: redirects (plain HTTP on the configured public host goes to https with a 308, the visitor's scheme read from `cf-visitor` then `x-forwarded-proto`, `/api/health` exempt; the legacy `/cv?lang=zh|cn` goes to `/cv/zh`; a trailing slash is removed), security headers on every response (`lib/security/responseHeaders.ts`, the CSP from `lib/csp.js`), the CSRF guard on unsafe methods for `/api/admin/*`, `/api/auth/*`, `/api/cvdata`, `/api/home`, `/api/versions` and `/api/mongo` (403 cross-site; 415 for form-encoded, multipart and text bodies; `lib/security/csrf.ts`), the admin gate for `/admin/*` and `/api/admin/*` (a login redirect for pages, JSON 401 for APIs; `lib/adminAuth/proxyGate.ts`), and the AI public paths, which exist only while AI access and connected apps are on (`lib/aiPublicRoutes.js`, `lib/ai/settings.ts`). The IndexNow key file `/<INDEXNOW_KEY>.txt` is rewritten to `/api/indexnow-key`.

API routes are wrapped by `withApi` (`lib/apiHandler.ts`): request logging with ids, error capture, and the activity-log record for every route `lib/audit/describe.ts` names.

ISR (Incremental Static Regeneration) timings: `/` and `/about` every 3600 s (`PROFILE_REVALIDATE_SECONDS`, `lib/isr.ts`), `/cv` and `/cv/zh` 60 s (`lib/cvPage.ts`), `/contact` 300 s (`lib/contactPage.ts`), posts, case studies, `/now`, `/uses` and `/publications` 60 s, `/colophon` static. Build-time renders get a 1 s window (`BUILD_REVALIDATE_SECONDS`) because the image is built without a store. After every save `lib/revalidate.ts` regenerates the affected paths on demand (a second confirming pass for CV and home paths), removes the persisted copies of pages that turned into a 404 (`lib/isrPages.ts`, `lib/isrCache.ts`), marks the search index stale, and fires the edge purge and IndexNow with a 3 s timeout, never failing a save. HTML stays at the edge for at most 5 minutes (`Cloudflare-CDN-Cache-Control`, `lib/edgeHtmlTtl.ts`) and is sent with `Cache-Control: no-transform` (`lib/htmlNoTransform.ts`).

## Project layout

```text
.
├── assets/              # Font sources (fonts/) and the PDF font subsets (pdf/)
├── components/          # UI: LandingPage/, Admin/, Search/, Chrome/, General-UI/, ...
│   ├── Admin/           # HomeEditor, CVEditorStudio, StoragePanel, RichEditor, shell/
│   │   └── ai/          # Admin → AI: assistant, changes, connections, models, Ask AI
│   └── LandingPage/     # PersonalInfo, Content, ExperienceTimeline, ...
├── content/             # MDX seed directory (blog/, work/); only .gitkeep files in git
├── data/                # Runtime state, gitignored except the two demo seeds
│   ├── content.db       # Canonical SQLite store
│   ├── analytics.db, auth.db, audit.db, ai.db
│   ├── home.json        # Tracked demo seed for hero / socials / brands / photos
│   ├── cvdata.json      # Tracked demo CV seed (en / zh, fictional)
│   ├── admin.json       # Local admin record (hash + salt), never in a snapshot
│   ├── snapshots/       # Version history per content kind
│   └── backups/         # snapshot-<UTC>.tgz and pre-migration/ copies
├── docs/                # This manual, docs/ai-trial.md, docs/screenshots/
├── e2e/                 # Playwright + axe suites; fixtures/store is the synthetic store
├── lib/                 # Server-side libraries
│   ├── contentStore.ts / db.ts / r2.ts     # The store and its mirror
│   ├── backup.ts / backupSchedule.ts / restoreDrill.ts
│   ├── admin.ts / auth.ts / adminAuth/     # scrypt, sessions, passkeys, step-up
│   ├── homeShape.ts / homeSections.ts      # HomeData schema and section keys
│   ├── currentlyCoding.ts                  # The chip derived from the CV
│   ├── env.ts / rateLimit.ts / mailer.ts
│   ├── security/        # csrf, safeFetch, loginThrottle, proxyTrust, ...
│   ├── analytics/ errors/ audit/ inbox.ts
│   ├── ai/              # Tools, plans, approvals, providers, agent loop, OAuth
│   └── mcp/             # The MCP server (server.ts, wired only by pages/api/mcp.ts) and its HTTP helpers (http.ts, shared with lib/ai)
├── pages/
│   ├── api/             # All server endpoints
│   │   ├── admin/       # Gated: storage, posts, work, page, ai/, orcid/, security/, ...
│   │   ├── auth/        # email-login, passkey/, request-reset, reset-password
│   │   ├── oauth/       # authorize, token, register, revoke, metadata, open
│   │   └── mcp.ts, home.ts, cvdata.ts, mongo.ts, og.tsx, health.ts, ...
│   ├── admin/           # Gated UI: dashboard, login, ai, system, security, ...
│   ├── zh/              # The Chinese pages
│   └── index.tsx, about/, blog/, work/, cv/, now.tsx, uses.tsx, colophon.tsx, ...
├── scripts/             # CLI: deploy.sh, migrate-db, sync-*-r2, perf-budget, check-*, ai-*
│   ├── db/              # Versioned migrations per store
│   └── ci/              # fixture-store.mjs, fixture-images.mjs
├── security/            # audit-allowlist.json (reviewed, expiring exceptions)
├── styles/ theme/       # globals.css; the design tokens and the Chakra theme
├── tests/               # node:test unit tests, register.mjs, no-network.mjs
├── proxy.ts             # Redirects, security headers, CSRF, admin gate (Node.js)
├── instrumentation.ts   # Boot: migrations, schedules, error capture
├── docker-entrypoint.sh # R2 reconcile, static archive, ISR warm-up, server
├── Dockerfile           # Two-stage node:22-alpine build
└── public/              # Static assets; uploads/ is runtime state
```

## Public routes

| Route | Description |
|---|---|
| `/` | Home — hero, proof strip and the sections in the owner's order (ISR, hourly + on save) |
| `/about` | Identity rail, the owner's bio and the open bilingual CV (ISR, hourly + on save) |
| `/cv` | CV in English (ISR, every minute + on save): A4 sheet / Reading view, skill evidence, downloads; `?print=1` opens the print dialog (every *Download PDF* link uses `/cv.pdf` / `/cv/zh.pdf`) |
| `/cv/zh` | The same CV in Chinese (`/cv?lang=zh` redirects here) |
| `/cv.pdf`, `/cv/zh.pdf` | Server-rendered A4 PDF (tagged, embedded fonts), dated file name, ETag |
| `/cv.txt`, `/cv/zh.txt` | Plain-text CV for paste-in application forms |
| `/cv.json`, `/cv/zh.json` | JSON Resume 1.0.0 of the public CV |
| `/cv/r/<token>`, `/cv/r/<token>/en.pdf`, `/cv/r/<token>/zh.pdf` | A private CV variant behind a signed, expiring, revocable link (`noindex`, `no-store`, `no-referrer`) and its PDFs |
| `/publications` | Papers from the CV's Publications section: citations, links, abstracts, Copy BibTeX / APA, ScholarlyArticle JSON-LD (404 while no paper is public) |
| `/work` | Case-study index (MDX) |
| `/work/[slug]` | Case study page with cover image + body |
| `/blog` | Blog index with tag filters + feed links |
| `/blog/[slug]` | Post: syntax highlighting, table of contents, lightbox images |
| `/now` | The "now" page: what the owner is doing at the moment (MDX) |
| `/uses` | Tools, hardware, services page (MDX) |
| `/contact` | Contact page (ISR): structured form with privacy notice, availability, copy buttons, vCard + QR |
| `/colophon` | How the site is built, privacy, changelog, deployed commit |
| `/zh`, `/zh/about`, `/zh/blog`, `/zh/work`, `/zh/contact` | The Chinese pages; each exists only while the owner wrote its Chinese copy (`lib/zhSite.ts`, `lib/zhRoutes.ts`) |
| `/feed.xml`, `/work/feed.xml`, `/feed.json` | Full-content RSS (writing, case studies) and JSON Feed |
| `/sitemap.xml` | Sitemap with EN / 中 alternates for the CV and for translated posts and case studies |
| `/llms.txt`, `/llms-full.txt` | Index for language models and agents (llmstxt.org) and every published post and case study in full, as Markdown |
| `/blog/[slug].md`, `/work/[slug].md` | Markdown version of a published post or case study (canonical link to the page, `noindex`) |
| `/review/<token>` | A review link: one draft (or unpublished changes) read-only under a "Preview" watermark; private, `no-store`, `noindex`, `no-referrer`; 410 once expired or turned off |
| `/api/search-index` | Public search documents (EN + ZH) and the Ask-mode passages for the command palette |
| `/api/vcard` | vCard of the public contact details |
| `/api/health` | Health: `{"status":"ok"\|"empty"\|"degraded"}` for everyone; store, content, backup age, the restore drill, open errors and pending R2 writes only for an admin or `Authorization: Bearer <HEALTH_TOKEN>` |
| `/api/og` | Social cards: `?card=<id>` for the fixed pages, HMAC-signed parameters for articles; anything else gets the default card |
| `/.well-known/security.txt` | RFC 9116 security contact (public CV e-mail, rolling 180-day expiry; 404 while the e-mail is hidden) |
| `/mcp` | The MCP server (POST only, `Authorization: Bearer` only, `no-store`, `noindex`); exists only while AI access and *Allow connected apps* are on and `SITE_URL` is set — otherwise it, and every row below, answers exactly like an unknown path |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` | OAuth discovery documents (`public, max-age=300`) |
| `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` | The OAuth 2.1 authorization server for connected apps; authorize is a same-site bounce to the consent page and stores and fetches nothing |
| `/ai/review/<id>` | A change's review link, as an app shows it: a same-site bounce to `/admin/ai/change/<id>` (no data; ids of any other shape are 404) |

The rewrites behind `/cv.*`, `/cv/zh.*`, `/cv/r/<token>/*.pdf`, `/blog/<slug>.md`, `/work/<slug>.md`, `/.well-known/security.txt` and `/uploads/*` are in `next.config.js`; the AI ones come from `lib/aiPublicRoutes.js`. The API surface lives under `/api/*`; admin-only endpoints under `/api/admin/*` are gated by the proxy (`proxy.ts`). The admin pages are listed in [docs/admin.md → Admin pages](admin.md#admin-pages).

## Test suites

Unit tests are `tests/*.test.ts` under `node:test`, followed by `tests/serial/*.test.ts` on their own (`yarn test`, or `yarn run check` for `tsc --noEmit`, ESLint with zero warnings and the suite together). `tests/register.mjs` resolves extensionless `.ts` imports and installs `tests/no-network.mjs`, which refuses any connection or DNS lookup off this machine and fails the test file that tried; the suite needs no `.env`. Helpers live in `tests/helpers/` (`fake-llm.mjs` is the scripted model provider), the ORCID fixtures in `tests/fixtures/`, and `tests/mcp-conformance-baseline.yml` is the reviewed baseline of the MCP conformance run.

The end-to-end suite (`e2e/`, `yarn e2e`, `e2e/playwright.config.ts`) runs against `E2E_BASE_URL` (default `http://127.0.0.1:3000`; a local `yarn start` listens on `http://127.0.0.1:3002`). Its projects: `chromium` (desktop, without `@admin` and the visual spec), `tablet` (768 × 1024) and `mobile` (Pixel 7) and `reduced` (reduced motion) on the public spec only, `webkit` (iPhone 15) and `firefox` on the cross-engine set, `visual` (`e2e/visual.spec.ts` and its baselines), and `admin` (`@admin`, one worker, after all of the others). The `ai-admin` (Chromium) and `ai-consent-firefox` projects are registered only when `E2E_FAKE_LLM_URL` is set, which `scripts/ai-e2e.sh` does; with it the config refuses any base URL that is not on `127.0.0.1`, so `yarn e2e` and a post-deploy run never list them.

The public specs check every public page on desktop, tablet, phone and reduced-motion profiles: one visible `h1`, `lang` (`zh-Hans` on `/cv/zh`), title and description, no serious or critical axe violations (WCAG 2.0 to 2.2 A/AA), no horizontal scroll, 24 × 24 px touch targets on phones (inline text links exempt), nothing animating under reduced motion, theme persistence, the ⌘K palette and the legacy redirect — and they fail on any console error, uncaught exception or CSP violation. The `@admin` specs sign in with `ADMIN_EMAIL` / `ADMIN_PASS` from the environment (`yarn e2e` does not read `.env`) and are skipped without them; they change content (hide and restore a CV field end to end, provoke a *Changed elsewhere* conflict between two editors, open the shortcuts overlay, follow a contact message into the Inbox), so leave them out with `--grep-invert @admin` for anything but a disposable store. The fixture store under `e2e/fixtures/store` (*Example Person*, generated images) is what `scripts/check-fixture-gates.sh` and `scripts/ai-e2e.sh` serve; the full gate list is in [docs/operations.md → Quality gates](operations.md#quality-gates).
