# Running it: environment, stores, backups, health, scripts, gates

Part of [Portfolio Studio](../README.md) · back to [Quick start](../README.md#quick-start)

This page is for whoever runs a deployment: every environment variable with its default, the five SQLite stores and their migrations, the backup pipeline with the restore paths and the restore drills, error monitoring, system health and the activity log, where each admin security control is documented, the CLI scripts, and the quality gates in full. Docker, the deploy script and Cloudflare are in [docs/deployment.md](deployment.md).

## Environment variables

All variables are documented in [`.env.example`](../.env.example); the repository never commits a real `.env` (it is gitignored and dockerignored, and no snapshot contains it). Headlines:

| Group | Vars | Required |
|---|---|---|
| Admin bootstrap | `ADMIN_EMAIL` (or `ADMIN_USER`), `ADMIN_PASS` | yes on first boot: `data/admin.json` is created from them only while it is missing (`lib/admin.ts`); remove `ADMIN_PASS` after a password change |
| Sessions | `JWT_SECRET` (`openssl rand -base64 32`; at least 32 random characters) | yes, always; also the root of the `/api/og` signing key and the MCP token tag key |
| Site identity | `NEXT_PUBLIC_PRODUCT_NAME`, `NEXT_PUBLIC_SITE_HOST` (build time), `SITE_URL` | recommended; `SITE_URL` is required for `/mcp` and OAuth |
| Default theme | `NEXT_PUBLIC_DEFAULT_THEME` (`dark` when empty, `light` or `system`; build time) | optional |
| Deployed commit | `NEXT_PUBLIC_BUILD_SHA` (build argument; `scripts/deploy.sh` exports it; shown on `/colophon`) | optional |
| Client IP | `TRUST_CLIENT_IP_HEADER` (`cf-connecting-ip` by default; `x-real-ip`, `x-forwarded-for` or `none`), `TRUSTED_PROXY_IPS` (IPs or CIDRs that may vouch for it; blank = loopback plus the container's default gateway) | optional — see [SECURITY.md → Client IP](../SECURITY.md#client-ip-libratelimitts-libsecurityipts-libsecurityproxytrustts) |
| Mailer | `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`, `NOTIFY_EMAIL`, `REPLY_FROM_EMAIL` (Inbox replies; defaults to the SMTP account's address) | optional — sending is skipped when unset (`lib/mailer.ts`) |
| Push notifications | `NOTIFY_NTFY_URL` (+ `NOTIFY_NTFY_TOKEN`), `NOTIFY_TELEGRAM_BOT_TOKEN` + `NOTIFY_TELEGRAM_CHAT_ID`, `NOTIFY_BARK_URL`, `NOTIFY_WEBHOOK_URL` (Slack / Discord incoming webhooks work as they are) | optional — each channel independent, HTTPS only ([Owner notifications](#owner-notifications)) |
| Contact captcha | none — built-in nonce + sum + honeypot | n/a |
| GitHub | `GITHUB_TOKEN` (fine-grained, public repositories read-only, no permissions) | recommended (raises the API limit from 60 to 5000 requests an hour) |
| MongoDB backup | `MONGODB_URI`, `MONGODB_DB_NAME` | optional; a URI from the environment makes `/admin/db-config` read-only |
| Cloudflare R2 | `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_REQUIRED` (`1` refuses to start without R2) | optional |
| Scheduled backups | `BACKUP_INTERVAL_HOURS` (default 24, `0` disables) | optional |
| Encrypted store backups | `STORE_BACKUP_KEY` (32 bytes, base64; keep a copy off the server), `STORE_BACKUP_INTERVAL_HOURS` (24, `0` off), `STORE_BACKUP_KEEP` (30), optional own bucket `STORE_BACKUP_R2_BUCKET` / `_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | recommended with R2 ([how](#encrypted-store-backups)) |
| Restore drills | `RESTORE_DRILL_INTERVAL_HOURS` (default 168, `0` disables) | optional |
| Contact retention | `CONTACT_RETENTION_DAYS` (default 365, `0` keeps messages until deleted) | optional |
| Link check | `LINK_CHECK_INTERVAL_HOURS` (default 24, `0` disables the schedule) | optional |
| Logging | `LOG_LEVEL` (`debug` / `info` / `warn` / `error`; JSON lines in production) | optional |
| Cloudflare purge | `CF_ZONE_ID`, `CF_API_TOKEN` (Cache Purge scope) | optional — nothing is sent unless both are set |
| IndexNow | `INDEXNOW_KEY` (8–128 of `[A-Za-z0-9-]`) | optional — off unless set |
| Health detail | `HEALTH_TOKEN` (bearer token for monitors) | optional — without it only a signed-in admin sees the `/api/health` detail |
| Admin step-up | `ADMIN_RECENT_AUTH_MINUTES` (1–60, default 10) | optional |
| Earlier builds' assets | `STATIC_ARCHIVE_DAYS` (days, 1–90, default 7) | optional |
| Image encoding | `IMAGE_JOB_CONCURRENCY` (images encoded at once, 1–4, default 1), `IMAGE_JOB_QUEUE_MAX` (uploads that may wait, 0–64, default 8; beyond that 503 "busy"), `SHARP_CONCURRENCY` (libvips threads per image, 1–4, default the CPUs, at most 2) | optional — the defaults keep concurrent uploads inside the 1 GiB container |
| ORCID connect | `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET`, `ORCID_ENV` (`production` default, or `sandbox`) | optional — without them "Connect your ORCID iD" stays disabled ([how](authoring.md#connect-your-orcid-id)) |
| AI ([how](ai.md)) | `AI_KEYS_SECRET` (32 random bytes, base64: `openssl rand -base64 32`; seals model keys, never derived from `JWT_SECRET`), `AI_DISABLED` (`1` turns every AI path off), `AI_LOCAL_PROVIDER_ORIGINS` (exact loopback origins such as `http://127.0.0.1:11434`, honoured only while `SITE_URL` is a loopback address) | optional — AI stays off until switched on in Admin → AI; the public MCP and OAuth addresses also need `SITE_URL` |

Read by code but not listed in `.env.example`: `PORT` (`yarn start` defaults to 3002; the Dockerfile sets 3000), `HOSTNAME` (the image sets it so the server listens on every interface of the container), `NEXT_TELEMETRY_DISABLED=1` (the image), `E2E_BASE_URL` and `E2E_FAKE_LLM_URL` (the Playwright config), `MCP_CONFORMANCE_TOKEN` (`scripts/mcp-conformance.sh`), `AI_SMOKE_KEY_<PRESET>` (`scripts/ai-live-smoke.mjs`), `STATIC_ARCHIVE_DIR` (`scripts/static-archive.mjs`), `WARM_HEALTH_TIMEOUT_MS` (`scripts/warm-isr.mjs`). The `NEXT_PUBLIC_*` values must be passed as Docker build arguments; `docker-compose.yml` forwards them from `.env`.

## Migrations

`yarn db:status` prints each store's schema version and what is pending, without writing; `yarn db:migrate` applies pending migrations to the stores that exist under `./data` (the app does the same when a store opens and at server start, so this is for looking before a deploy or migrating a copy: `node scripts/migrate-db.mjs --db content --file /tmp/copy.db`). Inside the container: `docker compose exec landing-page node scripts/migrate-db.mjs --status`. Exit codes: 0 ok, 1 a migration failed, 2 bad arguments. Before a new step touches an already versioned store, a copy is written with `VACUUM INTO` under `data/backups/pre-migration/` (newest 5), and `auth.db`, `audit.db` and `ai.db` are kept at mode 0600. The model (additive only, one transaction per step, exactly once across processes) is in [docs/architecture.md → Versioned SQLite migrations](architecture.md#versioned-sqlite-migrations).

## Backup pipeline

Whole-site snapshots are packed by `lib/backup.ts`. A snapshot holds content and nothing else:

```text
MANIFEST.json
db/content.db                     ← SQLite Online Backup API (consistent across WAL)
data/snapshots/<dir>/**           ← cv / home / blog / work / page version history
uploads/*                         ← public/uploads
data/inbox/contact-inbox.jsonl    ← contact messages (merged on restore, never replaced)
```

`MANIFEST.json` records every file's size and SHA-256, the row counts and the schema version of `db/content.db`. `data/admin.json` and `data/mongo_config.json` are never written into a snapshot, and when an older snapshot still carries them they are ignored on restore (`NEVER_RESTORED`): restoring content must never roll back the admin password. Also outside a snapshot: `.env`, `auth.db` (sessions, passkeys, review and share links, AI settings and tokens), `audit.db`, `ai.db` and `analytics.db`. The four stores get their own encrypted copy off the server ([Encrypted store backups](#encrypted-store-backups)); the deploy script's per-deploy backup — an online copy of all five stores, a tar of `data/` and a copy of `.env` — stays on the server, so keep `.env` itself in a password manager.

Pipeline: `tar pack → gzip → fs.WriteStream → atomic rename` (a snapshot is built in a temp file and renamed into place only once the tar finalises). Local copy at `data/backups/snapshot-<UTC>.tgz`, plus an R2 push to `backups/<UTC>.tgz` and `backups/latest.tgz` (the cheap pull target). Retention: the newest 20 tarballs locally (`LOCAL_KEEP`) and the newest 30 in R2 (`R2_KEEP`); snapshots older than `CONTACT_RETENTION_DAYS` are pruned too, the newest one always kept. `lib/backupSchedule.ts` takes a change-aware snapshot every `BACKUP_INTERVAL_HOURS` (default 24); the backup age shows in the Storage tab and in the `/api/health` detail.

**Restoring.** Admin → Storage (`/admin/dashboard?tab=storage`): *Backup now* packs a snapshot (`pages/api/admin/storage/backup.ts`); *Pull latest* opens the restore dialog whose button is *Pull and restore* (`pages/api/admin/storage/pull.ts`): it fetches R2's `backups/latest.tgz` (the default; 503 while R2 is not configured) or a local tarball by file name, writes a safety snapshot of the replaced state to `data/backups` first, then extracts to a sibling temp directory, closes the live DB handle, swaps the file and mirrors the uploads and version-history trees back over the live ones; afterwards every content row is re-mirrored to R2 and every public page that renders store content is regenerated. It answers `403 STEP_UP_REQUIRED` unless the owner signed in or re-verified within `ADMIN_RECENT_AUTH_MINUTES` (default 10), and 409 while another backup or restore is running. A new host with R2 credentials needs no manual restore: `scripts/sync-from-r2.mjs` rebuilds the store from the mirror at boot ([docs/deployment.md → Docker](deployment.md#docker)). An optional MongoDB GridFS target for backup and restore is configured at `/admin/db-config` (`pages/api/mongo.ts`).

### Encrypted store backups

`lib/storeBackup.ts` copies `auth.db`, `audit.db`, `ai.db` and `analytics.db` with SQLite's online backup API every `STORE_BACKUP_INTERVAL_HOURS` (default 24; the first run 15–25 minutes after a start), packs them with a `MANIFEST.json` (bytes, SHA-256, schema version) as tar.gz, seals the archive with AES-256-GCM under `STORE_BACKUP_KEY` and uploads it to R2 as `store-backups/<UTC>.pssb` and `store-backups/latest.pssb` — to `STORE_BACKUP_R2_BUCKET` when set (give it a write-only key and versioning or an object lock), else to the content mirror's bucket. The newest `STORE_BACKUP_KEEP` (30) dated archives are kept when the key may list and delete; with a write-only key, use the bucket's lifecycle rules. Off without the key or R2. A failed run is an owner notice ([Owner notifications](#owner-notifications)) and a health warning, as is a key that is missing while R2 is set, or a copy older than twice the interval. Admin → System → Health → *Off-server copy of the other stores* shows the state and has **Back up now** (`POST /api/admin/storage/store-backup`).

To open one (it writes only to the folder you name):

```bash
STORE_BACKUP_KEY=… node scripts/restore-stores.mjs --in store-2026-11-08T03-00-00-000Z.pssb --out ./restored
node --env-file=.env scripts/restore-stores.mjs --r2 --out ./restored          # store-backups/latest.pssb
```

It checks every file against the manifest. To put a store back: stop the container, copy the wanted `*.db` into `data/` (owner uid 1001; mode 0600 for `auth.db`, `audit.db` and `ai.db`), delete any `*.db-wal` / `*.db-shm` next to it, and start the container; migrations bring an older schema up to date. `ai.db`'s provider keys open only with the same `AI_KEYS_SECRET`, and sessions in `auth.db` only with the same `JWT_SECRET`.

**Restore drills** (`lib/restoreDrill.ts`): every `RESTORE_DRILL_INTERVAL_HOURS` (default 168, weekly) the newest backup — the R2 `backups/latest.tgz` when configured, else the newest local snapshot — is extracted into a scratch folder and checked: archive and manifest, every file's size and SHA-256, `PRAGMA integrity_check`, this build's migrations, row counts against the manifest, a render of the newest published article. The live site is never touched; results and a *Run drill now* button are in Admin → System health, and a failed or overdue drill is a `/api/health` warning.

<img src="../docs/screenshots/admin-storage.png" width="900" alt="Storage tab: snapshot schedule, Backup now and Pull latest buttons, local SQLite marked canonical, R2 state">

## Error monitoring and system health

First-party only, nothing leaves the server: uncaught browser errors, unhandled rejections and error-boundary catches (the reporter loads only when something fails), Content-Security-Policy violations and Trusted Types reports (`report-to` / `report-uri` → `/api/e`; the report-only Trusted Types groups are sampled, at most 50 events a group a day, and keep the sink name, never the sample text), and server errors (API routes, page renders, the proxy, any logged exception) are grouped by fingerprint in `data/analytics.db` — scrubbed of query strings, e-mail / IP addresses, tokens and ID-like numbers, with no address, user agent or cookie — and listed in Admin → System → Errors (`/admin/system?view=errors`: resolve, ignore, reopen; a resolved error that recurs reopens itself; open errors are kept 90 days, `lib/errors/store.ts`). Admin → System → Health (`/admin/system`, `lib/systemHealth.ts`) shows the deployed build, uptime, memory, free disk, each database's size, WAL and schema version, backups, the restore drill and the recent warn / error log entries. `/api/health` answers `{"status":"ok"|"empty"|"degraded"}` to everyone and the detail (store, content, backup age, the restore drill, open errors, pending R2 writes) to an admin or `Authorization: Bearer <HEALTH_TOKEN>`.

**Owner notifications** (`lib/ops/alerts.ts`, `lib/ops/push.ts`, `lib/ops/watch.ts`). What used to fail quietly now reaches the owner: a scheduled backup that failed (or skipped an empty store), one that was made but not copied to R2, a scheduled restore drill that failed, less than 10 % or 1 GB free on the data disk (checked hourly), a boot whose R2 sync failed (`docker-entrypoint.sh` exports `R2_BOOT_SYNC_FAILED=1` to the server), and a server error never seen before; and, as they happen, a contact message (name and subject only), a change a connected app proposed (checked every 5 minutes from `ai.db`, outside the AI tool layer) and the first open of a private CV link. Each goes by e-mail to `NOTIFY_EMAIL` (else the admin's address; needs SMTP) and to every push channel set in the environment — ntfy, Telegram, Bark or a JSON webhook — as `OPS_POLICY` says (contact messages are mailed in full by the contact route, so they only add a push). At most one notice per kind and subject (the error, the link) a UTC day, within a daily cap per kind (1 for the backup, drill, disk and R2 notices, 5 new server errors, 30 contact messages, 10 AI changes, 20 share links), claimed in `analytics.db`'s `meta` table so a restart does not resend. A notice is a title, a short text and a link to the admin page, sent through `safeFetch` (public HTTPS only, 5 s, in the background); a failure is logged with the channel's name, never its URL. AI-access alerts (`lib/ai/alerts.ts`) go to the same push channels. Admin → System → Health → **Notifications** shows what is set up and sends a test notice to all of it (also ⌘K → *Send a test notification*). The container is not restarted when its health check fails (`restart: unless-stopped` ignores health); an outside monitor of `/api/health` with `HEALTH_TOKEN` covers a dead server.

**Activity log** (Admin → System → Activity, `/admin/system?view=activity`): every successful admin write — saves, publishes, restores, deletes, Inbox changes and replies, uploads, backups, security changes, every AI write — with who (the signed-in browser: coarse device, network prefix, country; never a full address; or the AI actor), what and when, merged with the sign-ins and password resets of the sign-in history. It lives in its own `data/audit.db` (versioned migrations in `scripts/db/audit`; 400 days / 20 000 entries, `lib/audit/store.ts`), is copied by the deploy's online backups and is not in the content snapshots, so restoring content never rewrites it. Writes are recorded in `withApi` for every route `lib/audit/describe.ts` names; a route that only knows its action while it runs calls `recordAdminAudit(req, res, { action, area, target, summary })` (`lib/audit/record.ts`) after it succeeded, and a unit test fails when a writing route is in neither. The version history says which change replaced each version, and its diffs are word-level (Chinese segmented with `Intl.Segmenter`).

Logs are structured JSON lines in production with request ids and secret redaction (`lib/log.ts`, `LOG_LEVEL`); the container rotates them (`local` driver, 5 × 10 MB).

## Admin security — where each control lives

The maintained description of every control is [SECURITY.md → Security posture](../SECURITY.md#security-posture); this list says where to look.

- Proxy gate, the `cv_admin_token` session cookie (HS256 JWT, 7 days, revocation by session version and per-browser session row in `auth.db`), *Sign out everywhere*, sign-in history → [Authentication and sessions](../SECURITY.md#authentication-and-sessions); code `proxy.ts`, `lib/adminAuth/proxyGate.ts`, `lib/auth.ts`, `lib/adminAuth/sessions.ts`.
- scrypt password hashing (N=16384, r=8, p=1, 64-byte key, 16-byte salt), the password change and its rules (12 to 256 characters after NFKC, common-password checks), e-mail reset tokens (24 random bytes, 30 minutes, single use) → the same section; code `lib/admin.ts`, `lib/adminAuth/passwordPolicy.ts`.
- Passkeys (WebAuthn), ten one-time recovery codes, *Require a passkey* → the same section; code `lib/adminAuth/passkeys.ts`, `pages/api/admin/security/`.
- Step-up for dangerous actions within `ADMIN_RECENT_AUTH_MINUTES` (default 10) → the same section; code `lib/adminAuth/stepUp.ts`.
- Login throttle: per (e-mail, IP) backoff, a global slowdown and never a global lockout → [Login brute-force defence](../SECURITY.md#login-brute-force-defence-libsecurityloginthrottlets-libsecuritylogingatets); code `lib/security/loginThrottle.ts`, `lib/security/loginGate.ts`.
- Client IP and rate limits: `TRUST_CLIENT_IP_HEADER` honoured only from `TRUSTED_PROXY_IPS`, IPv6 bucketed per /64 (login per /48), an in-process limiter that resets on restart → [Client IP](../SECURITY.md#client-ip-libratelimitts-libsecurityipts-libsecurityproxytrustts); code `lib/rateLimit.ts`, `lib/security/proxyTrust.ts`, `lib/security/rateLimitCore.ts`.
- CSRF: 403 cross-site, 415 form bodies, on top of `SameSite=Strict` → [CSRF](../SECURITY.md#csrf-proxyts-libsecuritycsrfts); code `lib/security/csrf.ts`, `proxy.ts`.
- Uploads: name allow-list, sharp at upload time, no on-request optimizer (`/_next/image` answers 404) → [Uploads](../SECURITY.md#uploads); code `lib/security/uploadName.ts`, `lib/imageVariants.ts`.
- Hash-based CSP without `'unsafe-eval'` in production, Trusted Types report-only, HSTS, COOP / CORP, Permissions-Policy, `X-Robots-Tag` and `no-store` on admin pages → [HTTP headers](../SECURITY.md#http-headers-proxyts-libcspjs-libsecurityheadersjs); code `lib/csp.js`, `lib/security/responseHeaders.ts`, `lib/security/inlineScripts.ts`.
- SSRF: every server-side fetch of a URL that comes from content or an admin goes through `lib/security/safeFetch.ts` (public addresses only; size, redirect and time limits).
- Container hardening → [Container runtime](../SECURITY.md#container-runtime-dockerfile-docker-composeyml); backups → [Backups and restore drills](../SECURITY.md#backups-and-restore-drills); AI → [AI access](../SECURITY.md#ai-access).

## CLI scripts

```bash
yarn content:migrate    # seeds data/content.db from content/*.mdx and data/*.json (idempotent; --force overwrites)
yarn content:pull       # R2 → SQLite (overwrites; uses .env)
yarn content:push       # SQLite → R2 (overwrites; uses .env)
yarn content:list       # list R2 objects
yarn run check          # tsc + ESLint + unit tests
yarn e2e                # Playwright + axe against E2E_BASE_URL (default http://127.0.0.1:3000)
yarn audit:deps         # production-dependency audit gate (security/audit-allowlist.json)
yarn db:status          # schema version of each SQLite store (no writes)
yarn db:migrate         # apply pending migrations (also happens on start)
node scripts/perf-budget.mjs          # performance budget over the last `yarn build`
node scripts/subset-fonts.mjs         # re-split the Geist fonts (needs fontTools + brotli)
node --import ./tests/register.mjs scripts/bake-images.mjs           # variants of photos in public/images
node --import ./tests/register.mjs scripts/ci/fixture-store.mjs      # install the fixture store into a fresh checkout
node --env-file=.env scripts/cloudflare-config.mjs --dry-run   # Cloudflare zone config
node scripts/ai-trial.mjs [--fake-model]   # local AI trial in a linked worktree: loopback, synthetic content (docs/ai-trial.md)
bash scripts/ai-e2e.sh                # AI end-to-end gate on the standalone server
MCP_CONFORMANCE_TOKEN=<pst_ token> bash scripts/mcp-conformance.sh http://127.0.0.1:<port>   # MCP conformance + Inspector
node --import ./tests/register.mjs scripts/ai-live-smoke.mjs --real <preset>=<model>   # real providers, real keys, real cost
scripts/deploy.sh                     # deploy main to the server (docs/deployment.md)
```

## Quality gates

There is no hosted CI (`.github/` holds the issue and pull-request templates and `dependabot.yml`, no `workflows/`): run these before pushing to `main`.

| Command | What must pass | Required when |
|---|---|---|
| `yarn run check` | `tsc --noEmit`, ESLint with zero warnings (`--max-warnings 0`), the `node:test` unit suite (`tests/*.test.ts`, then `tests/serial/*.test.ts` on their own — the check that a unit run leaves `data/` untouched runs the suite again and must not compete with it; off-machine network is refused by `tests/no-network.mjs`; needs no `.env`) | every push |
| `yarn build`, then `node scripts/perf-budget.mjs` | `next build --webpack`, and the performance budget (`scripts/perf-budget.mjs`, KiB gzip): shared first-load JS ≤ 175, `pages/_app` ≤ 80, any public page ≤ 225, `/` ≤ 222, shared CSS ≤ 8, at most 2 font preloads weighing ≤ 75, and no server-only marker — `anthropic-version`, `modelcontextprotocol`, `AI_KEYS_SECRET` — in any client chunk | every push |
| `yarn e2e` | Playwright + axe (`e2e/`, [docs/architecture.md → Test suites](architecture.md#test-suites)) against `E2E_BASE_URL` (default `http://127.0.0.1:3000`); the `@admin` specs need `ADMIN_EMAIL` / `ADMIN_PASS` and change content, so add `--grep-invert @admin` unless the store is disposable | public UI changes; after a deploy, against the deployment |
| `yarn audit:deps` | `scripts/check-audit.mjs`: no high or critical finding in production dependencies unless allow-listed in `security/audit-allowlist.json` with a reason and an expiry date; expired entries fail too | every push |
| `bash scripts/ai-e2e.sh` | the AI flows on the **standalone** server the image runs, built from a temp copy of the checkout with the fixture store and no env file, next to the scripted test model (`tests/helpers/fake-llm.mjs`) on loopback: the Playwright projects `ai-admin` (Chromium) and `ai-consent-firefox` (Firefox). Needs `yarn playwright install chromium firefox` once | changes under `lib/ai`, `lib/mcp`, `components/Admin/ai` or the AI routes |
| `bash scripts/mcp-conformance.sh` | against a local build with AI on and a personal token: `@modelcontextprotocol/conformance` (spec 2026-07-28 and 2025-11-25, with the reviewed baseline `tests/mcp-conformance-baseline.yml`; a stale entry fails too), the authorization server's metadata scenario, and the Inspector CLI in the legacy, auto and modern eras, `--strict`, and the 401 path | the same AI changes |
| `scripts/check-container.sh` | the merged compose config publishes loopback only and keeps the hardening and the static-archive volume; the image builds, starts on fresh data holding only the git seeds, serves, warms its ISR pages, runs as uid 1001 with no capabilities and `NoNewPrivs`; the Playwright + axe suite passes against that container in Chromium (desktop, tablet, phone, reduced motion) and WebKit (iPhone), then the `@admin` specs with a throwaway admin; it stops in under 8 s. Needs Docker, `jq` and `curl`; `--no-e2e` skips the suite | the Dockerfile, `docker-entrypoint.sh` or a compose file |
| `scripts/check-fixture-gates.sh` | the synthetic fixture store (`e2e/fixtures/store`: *Example Person*, generated images — never the live content) is built and served in the pinned Playwright image the visual baselines were made in: CLS ≤ 0.05 and TBT ≤ 200 ms on a calibrated phone profile; no horizontal scroll at 375 / 768 / 1440 in Chromium, WebKit (iPhone) and Firefox; no image over 200 KB; axe on an article; and the visual baselines of the home page, an article, a case study, the CV and the contact page (dark / light × phone / tablet / desktop). `--update-snapshots` regenerates the baselines after an intended change. Needs Docker | public UI, images, fonts or the performance budget |
