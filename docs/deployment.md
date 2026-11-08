# Docker, the deploy script and Cloudflare

Part of [Portfolio Studio](../README.md) · back to [Deploying](../README.md#deploying)

This page is for putting a deployment on a server, host-neutral: the Docker image and the two compose files, the override contract every host needs, the boot order inside the container, `scripts/deploy.sh` step by step, and the optional Cloudflare zone configuration and cache purge. The deployment's own address is written `https://example.com`; the host the script drives is `$DEPLOY_HOST`; the backup directory on that host is `$BACKUP_ROOT`. Every environment variable is described in [`.env.example`](../.env.example) and [docs/operations.md → Environment variables](operations.md#environment-variables).

## Docker

```bash
cp .env.example .env                                                 # JWT_SECRET, ADMIN_EMAIL, ADMIN_PASS at least
cp docker-compose.override.example.yml docker-compose.override.yml   # once per host; gitignored
docker compose up -d --build                                         # http://127.0.0.1:3002
```

**The override contract.** `docker-compose.yml` is the base file: image `hiko-landing-page-frontend-ts-staging:latest`, `env_file: .env`, `restart: unless-stopped`, `mem_limit: 1g`, `cpus: 2`, `cap_drop: ALL`, `no-new-privileges:true`, `pids_limit: 256`, the named volumes `landing-data` (`/app/data`), `landing-uploads` (`/app/public/uploads`) and `landing-static-archive` (`/app/next-static-archive`), the port `127.0.0.1:8000:3000` and an external network named `easilycv`. `docker-compose.override.yml` is **not tracked**: each host keeps its own copy, made from `docker-compose.override.example.yml`, and `docker compose` merges it automatically. The example replaces the port with `127.0.0.1:3002:3000` (`ports: !override`; a reverse proxy or tunnel on the host connects there, and nothing else reaches the container), replaces the network with the default one (`networks: !override`), bind-mounts `./data` and `./public/uploads` over the two data volumes (the container writes them as uid 1001, the image's non-root user; on a Linux host make them writable for that uid) and rotates container logs (`local` driver, 5 × 10 MB). It must not `!override` the `volumes` list, or the static-archive volume is lost on every deploy. `scripts/check-container.sh` asserts that the merged configuration publishes loopback only and keeps the hardening.

The root file system stays writable: ISR rewrites prerendered pages under `/app/.next/server`; making it read-only would need that directory on a volume re-seeded from the image on every deploy. A page that turns into a 404 (a deleted or unpublished post or case study, `/publications` without a paper) has its persisted copies removed there after every content write and at start (`lib/isrCache.ts`, `lib/isrPages.ts`), because Next would otherwise serve the last 200 copy again after a restart.

**The image.** Built with BuildKit (`# syntax=docker/dockerfile:1.7`): yarn and Next caches live in cache mounts, `yarn install --frozen-lockfile` fails the build when `yarn.lock` is out of sync, both stages use `node:22-alpine` pinned by digest (Dependabot proposes digest bumps), `scripts/bake-images.mjs` runs before `yarn build`, the build-time `content.db` is deleted, glibc sharp binaries are dropped (Alpine runs musl), and the release stage carries only Next's traced standalone output — a build-time check proves the content scripts' modules (`better-sqlite3`, `gray-matter`, `@aws-sdk/client-s3`, `sharp`) load from it. The container runs as uid 1001 (`nextjs`), exposes port 3000 and has a `HEALTHCHECK` on `/api/health` every 30 s. Runtime settings come from `.env` (`env_file`); `NEXT_PUBLIC_SITE_HOST`, `NEXT_PUBLIC_PRODUCT_NAME`, `NEXT_PUBLIC_DEFAULT_THEME` and `NEXT_PUBLIC_BUILD_SHA` are also build arguments (`docker-compose.yml` forwards them from `.env`) because Next inlines them at build time, so changing one needs `--build`. `NEXT_PUBLIC_BUILD_SHA` (set by the deploy script) puts the deployed commit on `/colophon`.

**Boot order.** `docker-entrypoint.sh` runs under `dumb-init` (PID 1, so `docker stop` reaches the server): first `scripts/sync-from-r2.mjs` reconciles the local SQLite store with the R2 mirror by real timestamps and repairs writes that never reached R2 — exit 0 or 3 (R2 failed, local content intact) continues, anything else refuses to serve an empty site and the restart policy retries; then `scripts/static-archive.mjs` (below); then `scripts/warm-isr.mjs` in the background, which regenerates every statically generated page from the real store once the server is healthy (the image is built without a database); then `exec node server.js`. `./data` and `./public/uploads` are persisted through volumes or bind mounts.

**Earlier builds' assets.** Every build has new chunk names, and an image carries only its own `.next/static`. So that a page loaded before a deploy (an open tab that lazily loads a chunk, or HTML still in an edge cache) keeps working, the `landing-static-archive` volume (`/app/next-static-archive`) collects each build's `/_next/static` files at start-up and copies the ones of the builds deployed in the last week (`STATIC_ARCHIVE_DAYS`, 1 to 90, default 7) back next to the new build's — never replacing one of its files (all names are content hashes or the build id). It holds build output only (a few MB per build) and may be deleted at any time.

Inside the container the migration status and the edge purge can be checked with `docker compose exec landing-page node scripts/migrate-db.mjs --status` and `docker compose exec landing-page node scripts/edge-purge.mjs --dry-run`.

## Deploying to production

`scripts/deploy.sh [--force]` is the only deploy path. It runs on your machine and drives one server over `ssh $DEPLOY_HOST` (an alias in `~/.ssh/config`; `DEPLOY_HOST`, `DEPLOY_DIR` and `DEPLOY_SITE_URL` are environment overrides read at the top of the script, and the defaults in the script are the original deployment's). The server has no GitHub credentials: the new commits travel as a git bundle.

```bash
git switch main && git pull && git push   # main == origin/main
scripts/deploy.sh                         # --force rebuilds the deployed commit
```

1. **Preflight** — clean tree, on `main`, `main` pushed to `origin`, the server reachable and its HEAD an ancestor of `main` (fast-forward only).
2. **Backups** in `$BACKUP_ROOT/<UTC timestamp>/` on the server (`BACKUP_ROOT` is a constant in the script's remote half): an online SQLite backup of the stores through the running container's better-sqlite3 `.backup()`, a tar of `data/` (without its own `backups/`) and `public/uploads/`, copies of `.env` and the compose override; the running image is tagged `<image>:pre-<timestamp>`.
3. **Update** — the checkout fast-forwards from the bundle. The server's own `data/home.json` and `docker-compose.override.yml` are kept byte for byte; any other local modification stops the deploy. A file the update deletes and `.gitignore` now ignores keeps its server copy.
4. **Build** — `docker compose build` while the old container keeps serving. A failed build resets the checkout; nothing else changed.
5. **Switch** — `docker compose up -d --no-build`, then wait for the container to be `healthy` and log `[warm-isr] regenerated`, for `/api/health` to report `"status":"ok"`, and for the port to be bound to `127.0.0.1` only.
6. **Edge purge** — the ISR pages are edge-cacheable, and the previous build's HTML points at chunks the new image does not have. Inside the new container, `scripts/edge-purge.mjs` purges the Cloudflare zone with the app's own `CF_ZONE_ID` + `CF_API_TOKEN` (Cache Purge; the token never leaves the server): `purge_everything`, or — if Cloudflare refuses that — every cacheable page, feed and sitemap URL in batches of 30. Without the credentials (or if the purge fails) the deploy prints a warning and carries on: Cloudflare keeps HTML at most 5 minutes anyway (the origin sends `Cloudflare-CDN-Cache-Control: max-age=300, stale-if-error=86400` on HTML whose own shared lifetime is longer — `/`, `/about`, `/colophon`; `lib/edgeHtmlTtl.ts`), and the old HTML still hydrates meanwhile because earlier builds' assets are kept (Docker, above). That cap is always on, not only without credentials: a purge can fail, the build cannot know the runtime credentials, and a refetch from the ISR cache every few minutes per edge location costs next to nothing.
7. **Smoke test** through `DEPLOY_SITE_URL`: the main pages, feeds, sitemap, health and the legacy CV redirect (cache-busting query, so the new origin answers); `/` must reference the new build id (`.next/BUILD_ID`). Then `/` without a query string — what visitors get from the edge — is checked for the new build id too (a few tries); a stale edge copy is reported, not rolled back (the origin is fine, a rollback cannot refresh the edge, and the copy still works).
8. **Rollback** on any failure after the switch: `docker tag <image>:pre-<timestamp> <image>:latest && docker compose up -d --no-build`, the checkout reset, the failed container's last 100 log lines and the backup paths printed. On success: `.deployed-sha`, image pruning (the three newest rollback images are kept) and backup pruning: only the ten newest `<UTC timestamp>/` backup directories are kept (`KEEP_BACKUPS`; each holds a copy of `.env`), every removed one is listed, and nothing else in `$BACKUP_ROOT/` is touched.

Afterwards, run the public E2E suite against the deployment:

```bash
E2E_BASE_URL=https://example.com yarn e2e --grep-invert @admin
```

## Cloudflare

Optional: the site runs behind any reverse proxy. `scripts/cloudflare-config.mjs` keeps the zone configuration in the repository and applies it idempotently (read each setting / ruleset, write only what differs, print the diff; `--dry-run` writes nothing; exits 1 on any API error). Rules it manages carry a `lp_` ref (`REF_PREFIX`); rules added in the dashboard are kept.

- Zone settings: **Always Use HTTPS** on, **Email Address Obfuscation** off (its rewritten markup broke React hydration).
- Configuration rule for the site host: email obfuscation off, Web Analytics (RUM) injection off — the site has its own analytics and its CSP stays unchanged.
- Redirect rule: `www.<host>` → `https://<host><path>` (308, query kept); the proxied `www` CNAME is created when missing.
- Cache rules: the public pages, feeds, sitemap, `/api/og`, `/api/stack`, `/api/search-index` and `/api/github/*` are cache-eligible with the edge TTL taken from the origin (`s-maxage` from ISR pages; server-rendered pages send `no-store` and stay uncached); `/admin*`, `/api/admin*`, `/api/auth*` and any request with the admin session cookie bypass the cache.

```bash
CF_API_TOKEN=<token> CF_ZONE_ID=<zone-id> node scripts/cloudflare-config.mjs --dry-run
CF_API_TOKEN=<token> CF_ZONE_ID=<zone-id> node scripts/cloudflare-config.mjs
```

The host comes from `NEXT_PUBLIC_SITE_HOST` / `SITE_URL` in `.env` (`node --env-file=.env`), or `--host <host>`. Token scopes for this one-off run: Zone Settings:Edit, Config Rules:Edit, Cache Rules:Edit, Dynamic Redirect:Edit, DNS:Edit, and optionally Account Analytics:Edit (without it the script prints the manual dashboard step to turn Web Analytics' automatic setup off). Use a short-lived token and revoke it afterwards.

At runtime, with `CF_ZONE_ID` + `CF_API_TOKEN` (a token with Cache Purge only) every on-demand revalidation purges the refreshed URLs — plus the feeds, sitemap and search index when posts or case studies change — in batches of 30; with `INDEXNOW_KEY` the page URLs are submitted to IndexNow (the key file is served at the site root as `/<INDEXNOW_KEY>.txt`, because a key file only covers URLs in its own directory and below; the proxy rewrites exactly that path to `/api/indexnow-key`). Both are fire-and-forget with a 3 s timeout, logged, and never fail a save (`lib/revalidate.ts`); without the env nothing is sent. The same credentials purge the whole zone after every deploy (`scripts/deploy.sh`, `scripts/edge-purge.mjs`), and HTML never stays at the edge longer than 5 minutes (`Cloudflare-CDN-Cache-Control`, read by Cloudflare only; `lib/edgeHtmlTtl.ts`).
