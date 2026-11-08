# Security policy

Thanks for helping keep this project safe.

## Supported versions

Only `main` is supported. There are no release branches — fixes ship as
new commits and a redeploy is the upgrade path.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

Report privately by e-mail to the address in the live site's
`/.well-known/security.txt`
(RFC 9116). Its `Contact:` line is the maintainer's public e-mail, taken
from the CV the site publishes, and its `Expires:` date always lies about
six months ahead. GitHub's private vulnerability reporting is not enabled
for this repository, so e-mail is the channel.

Every deployment of this project serves its own file at
`https://<host>/.well-known/security.txt` (`pages/api/security-txt.ts`,
`lib/securityTxt.ts`): the contact comes from the public CV, and the file
answers `404` while the CV hides its e-mail address.

Acknowledgement target: 72 hours. Initial assessment: 7 days. Coordinated
disclosure preferred — public write-ups land after a patch is available.

### What to include

- A minimal reproduction (URL or curl command + expected vs actual).
- Affected commit SHA from `main` (`git rev-parse HEAD`).
- Your assessment of impact and severity.
- Whether you'd like public credit when the fix is published.

### Out of scope

- Findings that require physical access to the host machine.
- Self-XSS that requires the victim to paste arbitrary content into
  their own browser console.
- Reports from automated scanners with no manually-verified reproduction.
- Missing security headers on `localhost` development builds.

## Security posture

What the code actually does today, and where its limits are.

### Authentication and sessions

- **Single admin account** stored in `data/admin.json` (bind-mounted,
  gitignored, written atomically with mode `0600`). Bootstrapped from
  `ADMIN_EMAIL` / `ADMIN_PASS` on first use — only while the file does not
  exist: one that exists but cannot be read or parsed is never overwritten,
  and until it is repaired (or removed, to bootstrap again) every admin
  session check fails closed and nobody can sign in.
- **Password hashing** — scrypt (`N=16384, r=8, p=1`, 64-byte key) with a
  random 16-byte salt; constant-time compare. The NFKC form of the password
  is hashed and checked (NIST SP 800-63B), marked `passwordNorm: 'NFKC'` in
  `data/admin.json`; a record from before that is checked as typed until its
  next change or reset.
- **Password change** (Admin → Security → Password,
  `POST /api/admin/security/password`, `lib/adminAuth/password.ts`) — needs
  the admin session and the current password, checked exactly like a
  sign-in (async scrypt, constant time, the same per-(e-mail, client)
  lockout) and answered only "incorrect" when wrong; failures are counted
  with the failed sign-ins (a request turned away by the lockout before any
  check is not). Because that lockout is per network, the session is a
  budget of its own: after 5 wrong passwords — current passwords here and
  password step-ups together (`lib/adminAuth/wrongPasswords.ts`) — the
  session is signed out (`too many wrong passwords`, in the sign-in history)
  and the answer is `401 SIGNED_OUT`; a right password resets the count. So
  a stolen session gets at most 5 guesses, from any number of networks.
  Also 10 attempts per 15 minutes per client, 30 per IPv6 /48, and at most
  30 current-password checks an hour for the whole site. The new
  password (`lib/adminAuth/passwordPolicy.ts`, shared with the e-mail reset
  and the page's live checklist): 12–256 code points after NFKC, any
  characters, not built from very common password words or the best-known
  passphrases (across spaces and dashes: "correct horse battery staple"),
  keyboard or alphabet runs (zig-zags such as `1q2w3e` and numpad columns
  included), stuttered runs (`112233`), repeats or years (look-alikes such
  as `p@ssw0rd` included), not containing the e-mail's local part or the
  site's name, not the current password. The strength hint counts a run of
  letters that reads like a word as one word (about 13 bits), so a
  passphrase needs about five words to show as strong; it only guides — the
  rules decide. A refused password costs no hash and no lockout
  attempt. One change at a time, compare-and-swap against the verified hash,
  fresh salt, atomic write, every reset link burnt. "Sign out other
  browsers" (on by default) bumps the session version and revokes every
  other session row (`password-changed`) and every pre-session token; in
  every case this browser gets a new session (row + cookie, verified now)
  and its old token ends. Recorded in the sign-in history
  (`password-changed`) and the activity log (no secrets); with SMTP, a
  notice (time, browser, country — no address — and what to do if it was
  not you) goes to `NOTIFY_EMAIL`, else the account address, and a mail
  failure never fails the change. The page says whether `ADMIN_PASS` in the
  environment still equals the password (computed server-side, never sent).
- **Session cookie** — `cv_admin_token`, an HS256 JWT (algorithm pinned on
  verify) valid for 7 days; `httpOnly`, `SameSite=Strict`, `Secure` in
  production, `path=/`.
- **Two-layer gate** — the proxy (`proxy.ts`, Next.js 16's proxy on the
  Node.js runtime) checks the session before every `/admin/*` page
  (guests → `307 /admin/login?next=…`) and `/api/admin/*` route (guests →
  JSON `401`): signature, expiry, role, session version and session row
  (`lib/adminAuth/proxyGate.ts`; read-only, fail-closed when `admin.json`
  exists but cannot be read or parsed, or `auth.db` cannot be read). Every
  API handler then calls `lib/auth.ts`,
  the authoritative check, which also refreshes the session's last-seen
  time.
- **Sessions** (`lib/adminAuth/sessions.ts`, `data/auth.db`, owner-only:
  the file, its `-wal` / `-shm` files and its pre-migration copies are
  `0600`) — every sign-in creates a session row; the JWT carries its id (`sid`) and is honoured only
  while the row exists, is not revoked and has not expired. Admin → Security
  lists the signed-in browsers (browser · OS, an IPv4 /24 or IPv6 /48 prefix,
  the Cloudflare country — never a full address or user agent) and signs any
  of them out. **Log out** (`POST /api/admin/logout`) signs out this browser
  only; "Sign out everywhere" (Security page) also bumps the session version.
  An anonymous logout request only clears its own cookies.
- **Session version** — `data/admin.json` holds `sessionVersion`; every
  token carries it as `sv` and is honoured only while the two match. It is
  bumped by "Sign out everywhere" and by a **password reset** (which also
  burns all outstanding reset links and revokes every session row). A token
  minted before sessions existed (no `sid`) still needs a matching `sv`; the
  first page view swaps it for one bound to a new row. Such a token cannot
  be listed or revoked on its own, so the first time the owner signs any
  browser out (Log out, one browser, the other browsers) a cutoff is stored
  in `auth.db` and every `sid`-less token issued until then is refused;
  a week after `auth.db` was created none can be valid anyway. A revoked or
  signed-out token loads neither an admin page shell (the proxy sends it
  to the sign-in page) nor any admin API (`401`).
- **Passkeys** (`lib/adminAuth/passkeys.ts`, @simplewebauthn/server) — sign
  in with a passkey (button, or the e-mail field's autofill) instead of the
  password. The relying-party id is the configured public host (a request's
  Host never becomes it) or `localhost` for local work; IP hosts have none.
  User verification is required, attestation is not requested, challenges
  are 32 random bytes, single use and expire after 5 minutes (registration
  and step-up challenges are bound to the session), the signature counter is
  enforced, and an unknown credential is reported so the browser can forget
  it. Registration needs a recent verification.
- **Recovery codes** — ten per set, 80 random bits each (Crockford base32),
  stored only as SHA-256, each usable once; shown once when created (with
  the first passkey, or on request).
- **"Require a passkey"** — once on, the password alone neither signs in nor
  verifies: it needs a recovery code too. Without a code the sign-in answers
  `403 PASSKEY_REQUIRED` before any password check; a wrong password and a
  wrong code get the same `401`, and a wrong code counts for the lockout.
- **Step-up** (`lib/adminAuth/stepUp.ts`) — restoring a backup, deleting a
  post or case study, deleting an image from the media trash for good,
  MongoDB restore or target changes, every passkey,
  recovery-code, policy or other-browser change, and a password change
  while "Require a passkey" is on require a sign-in or a
  re-verification on this browser within `ADMIN_RECENT_AUTH_MINUTES`
  (default 10); otherwise the route answers `403 STEP_UP_REQUIRED` and the
  admin asks for a passkey or the password (+ code). A token from before
  sessions existed never counts as recent. A password change while the
  password may sign in asks for nothing more: its current-password field is
  that re-verification (asking twice would add nothing); with "Require a
  passkey" on, the password alone proves nothing, so the change needs the
  step-up as well. A password step-up shares the sign-in lockout, has 10
  attempts per 10 minutes per client and 30 per IPv6 /48, and its wrong
  passwords count against the session's budget of 5 (above).
- **Sign-in history** — sign-ins, failures (time, method, country and a
  reason code; no address or device) and security changes, the newest 500
  for at most 180 days.
- **`data/auth.db` is per server**: it is not in the content snapshots, the
  R2 mirror or restores (so a restore cannot bring back a removed passkey, a
  spent code or a revoked session), but `scripts/deploy.sh` backs it up with
  the other databases. After moving to a new server, sign in with the
  password (`ADMIN_EMAIL` / `ADMIN_PASS` bootstrap) and register passkeys
  again. If `auth.db` itself is damaged, the admin fails closed: move it
  aside, restart, sign in with the password.

### Login brute-force defence (`lib/security/loginThrottle.ts`, `lib/security/loginGate.ts`)

Designed so that it caps guessing for the whole internet together, yet
cannot be turned into a lock-out weapon against the owner:

- **Per (email, client) lockout with exponential backoff** — 4 free
  mistakes; the 5th locks that email *for that client network* for 30 s,
  then 60 s, 2 min, … up to 1 h. History is forgotten after 24 h without a
  failure, and a successful login clears it. An attacker only ever locks
  out their own network; the owner signing in from anywhere else is
  unaffected. A locked pair is answered at once, without hashing.
- **Per-client limits** — 10 login attempts per 5 min (tightened to 4
  while the site is under a distributed attack) and 30 per hour, per IPv4
  address or IPv6 `/64`; IPv6 clients additionally share a `/48` budget of
  three times that, because one customer (or one free tunnel-broker
  account) gets a whole `/48` — 65,536 `/64`s.
- **Global throughput cap, never a global lockout** — once 30+ failures
  from all clients land within 15 min, the site is "under pressure" and
  every credential check from an unrecognised browser passes through one
  process-wide serial queue: a check starts only after the previous one
  finished and the slowdown delay (0.5 s per 30 recent failures, up to 4 s)
  has passed. At the maximum that is 15 guesses a minute for everyone
  combined, however many addresses are used. The queue is bounded (at most
  ~30 s of waiting, 32 entries); past that the request gets the generic
  `429` immediately. Outside an attack up to 8 checks run concurrently, and
  any burst beyond that is queued too.
- **Known devices** — a successful login also sets `cv_known_device`, a
  random device id signed with HMAC-SHA256 under `JWT_SECRET` (180 days,
  `httpOnly`, `SameSite=Strict`, `Secure` in production). A browser
  carrying a valid one skips the global queue, so the owner can sign in
  during an attack; it still obeys the per-(email, client) lockout and the
  per-client limits, and grants nothing else. Log out does not clear it
  (it identifies the browser, not a session); rotating `JWT_SECRET` forgets
  every device. Signing in from a new browser during an attack means
  waiting in the queue.
- **Event loop stays free** — login uses the asynchronous `crypto.scrypt`,
  so a flood of attempts cannot block other requests.
- **No account enumeration** — unknown emails go through the exact same
  path as wrong passwords: one scrypt hash, the same throttling state,
  the same `401 Invalid credentials`, and the same generic `429` message,
  which never confirms an address. Password-reset requests always answer
  `{ ok: true }` without waiting for SMTP, and at most 3 reset links can be
  outstanding at once (no inbox flooding). Setting the new password checks
  the link first (without spending it): any token that is not a live link
  gets `400 Invalid or expired token` whatever the password, so the
  password rules — one of which names the e-mail's local part — only ever
  answer the holder of a real link.
- Throttle and queue state live in process memory and are bounded; a
  restart (which only the operator can trigger) clears them.

### Client IP (`lib/rateLimit.ts`, `lib/security/ip.ts`, `lib/security/proxyTrust.ts`)

- The client address comes from `TRUST_CLIENT_IP_HEADER` (default
  `cf-connecting-ip`, which Cloudflare overwrites at its edge), falling back
  to the TCP peer when the header is missing or malformed.
- The header is only believed when the TCP peer is a trusted proxy:
  `TRUSTED_PROXY_IPS` (IPs and CIDRs, IPv4 and IPv6) when set; otherwise
  loopback plus the container's default gateway, read once from
  `/proc/net/route` (Linux; elsewhere loopback only). In the standard
  deployment cloudflared runs on the host and reaches the container
  through Docker's `127.0.0.1:3002 → 3000` mapping, so its connections
  arrive from that gateway. Any other peer — a sibling container talking
  to the container's address directly, for instance — is rate-limited by
  its own socket address and cannot pick a fresh client IP per request.
  Every process on the host also connects from the gateway address: the
  host is inside the trust boundary.
- `x-forwarded-for` is read right-to-left, skipping trusted hops.
- IPv6 clients are rate-limited per `/64`, so one end-user network can't
  rotate through fresh addresses (login also per `/48`, see above).
- The edge `/api/og` route cannot see the TCP peer and uses the header as
  is; it only applies a coarse render limit (60/min).

### CSRF (`proxy.ts`, `lib/security/csrf.ts`)

For `POST` / `PUT` / `PATCH` / `DELETE` to `/api/admin/*`, `/api/auth/*`,
`/api/cvdata`, `/api/home`, `/api/versions` and `/api/mongo`:

- `Sec-Fetch-Site: same-origin` or `none` → allowed.
- Otherwise an `Origin` header, when present, must match the request host
  (`Host` / `X-Forwarded-Host`) or the configured site (`SITE_URL`,
  `NEXT_PUBLIC_SITE_HOST`); `Origin: null` and foreign origins → `403`.
- Requests with neither header (curl, scripts) are allowed — they carry no
  ambient browser cookie, and privileged routes still need a valid session.
- Form-encoded, multipart and `text/plain` bodies → `415`. These endpoints
  only accept JSON (or no body), which a cross-site page cannot send
  without a CORS preflight that this site never grants.
- `SameSite=Strict` on the session cookie is the second, independent layer.

The AI routes the owner uses (`/api/admin/ai/*`: approvals, consent, tokens,
keys, the assistant's run stream) are under `/api/admin/` and get all of the
above, and a bearer token there is `401` from the proxy. The public AI
addresses are **deliberately outside** this guard, because none of them
acts on a browser's ambient authority:

- `/mcp` (and `/api/mcp`) never reads a cookie: it needs
  `Authorization: Bearer`, so a cross-site page has nothing to ride on. It
  does its own `Host` check against `SITE_URL` and an `Origin` allow-list
  instead (the CSRF rule's "no `Origin` is fine" plus `Host` from the
  request would pass DNS rebinding).
- `/oauth/token` and `/oauth/revoke` must take
  `application/x-www-form-urlencoded` from any client (RFC 6749, RFC 7009),
  which the `415` rule would refuse; what they act on is in the body (a
  single-use code with its PKCE verifier, a refresh token), never a cookie.
- `/oauth/register` stores nothing (the client id is a signed copy of what
  was sent), `/oauth/authorize` and `/ai/review/<id>` are `GET` bounces that
  read no cookie and change nothing, and the discovery documents are public.

### Uploads

- Admin-only; MIME allow-list (PNG, JPEG, WebP, GIF, AVIF) checked against
  the file's magic bytes, ≤ 8 MB, canonical extension forced.
- One filename rule (`lib/security/uploadName.ts`) is shared by the upload
  endpoint and the `/uploads/*` file server: a single segment of
  `[A-Za-z0-9._-]`, no leading dot, no `..`. Every stored name is therefore
  servable and included in snapshot backups. Names are never overwritten
  (collisions get a content-hash suffix).
- Served files carry `X-Content-Type-Options: nosniff` and a sandboxing
  `Content-Security-Policy`, so even an SVG opened directly can't run script.

### Other endpoints

- **Contact form** — signed single-use nonce (2 s minimum fill time),
  honeypot, per-client limit (5 per 10 min); header-injection-safe. Every
  message is kept in the admin Inbox (`data/contact-inbox.jsonl`) as well
  as emailed when SMTP is configured, within site-wide caps: at most 300
  messages stored per UTC day and nothing more once the log reaches 5 MB
  (a warning is logged once per day). Past a cap a message is still
  emailed when possible; when it can be neither emailed nor stored the form
  answers `503` ("try again later") — never a fake success. Inbox reads are
  bounded (only the newest ~6 MB of the log is parsed; other operations
  stream it in 64 KB chunks), so a large log cannot exhaust memory.
- **Inbox deletion and backups** — snapshots (`lib/backup.ts`) include the
  inbox log, so a deleted message remains in up to 20 local and 30 R2
  backups until they rotate out. Restoring merges the backup's log into the
  live one, but skips every id the owner deleted (the newest 5,000 deleted
  ids are remembered in `data/contact-inbox.state.json`), so a restore does
  not resurrect deleted messages. To erase a message from backups too,
  delete it and then let newer snapshots replace the old ones (or remove
  old tarballs).
- **`/api/og`** (Node runtime) — never renders free text without a valid
  signature: fixed pages use fixed cards by id (`?card=about`), article
  cards carry an HMAC-SHA256 signature over their canonical parameters
  (key derived from `JWT_SECRET` with HKDF, computed in the page loaders,
  checked in constant time), and anything else gets the generic default
  card (rendered once per size, cached one day instead of a year). Text is
  clamped by code point, the cover is a same-site upload only, per-IP render
  limit (60/min), `Cache-Control: public, max-age=86400, s-maxage=31536000,
  immutable` for real cards.
- **`/api/e`** (error reports) — browser error reports and CSP / Trusted
  Types violation reports (the policies' `report-to` endpoint and
  `report-uri`, same origin). 8 KB browser error reports; report uploads
  up to 64 KB (the Reporting API batches a minute of reports), at most 20
  reports kept per upload with enforced violations first; per-client and
  per-network minute budgets. Browser reports may hold at most 300 of the
  500 fingerprints, add at most 30 new ones an hour (all senders together)
  and store 20 000 events a day, while server errors keep their own room
  and daily budget (a new one replaces the least valuable browser report
  when the table is full), so anonymous reports can never hide a server
  error. Report-only (Trusted Types) groups are sampled before those
  budgets: at most 50 events per group and 200 groups per UTC day, and
  only the sink name ("Element innerHTML") is kept, never the sample text.
  DNT / GPC, bots and cross-site posts are dropped. Query strings, e-mail
  and IP addresses, tokens and ID-like numbers are scrubbed before storage;
  chunk hashes are removed from script URLs so one problem keeps one group
  across deploys; no address, user agent, cookie or body is kept. Always
  `204`.
- **`/api/internal/restore-drill`** — loopback peers with the per-process
  in-memory token only (`lib/internalJobs.ts`); everyone else gets `404`.
- **`/api/health`** — anonymous callers get only `{"status": …}` (`200`, or
  `503` when the store is unreachable). The operational detail (backup
  times, R2 configuration, pending R2 writes, warnings, uptime) goes only to
  a signed-in admin or to `Authorization: Bearer <HEALTH_TOKEN>` when that
  variable is set (constant-time compare), so the public cannot read the
  last deploy or backup time off it.
- **MongoDB backup target** (`/api/mongo`, admin-only) — connection strings
  are masked by a URI-grammar parser that also handles multi-host URIs and
  passwords containing `@` or `/`; secret query options are redacted; error
  messages are scrubbed of the password before they are logged or returned.
  Admin credentials are never backed up to or restored from Mongo.
- **Public content APIs** return only the public (visibility-pruned) view of
  the CV and home documents; the full documents are served to the admin
  only, with `Cache-Control: no-store`.

### HTTP headers (`proxy.ts`, `lib/csp.js`, `lib/securityHeaders.js`)

The proxy sets every header on every response it handles
(`lib/security/responseHeaders.ts`: all routes but the fingerprinted
`/_next/static/*` files and `/favicon.ico`, which get the
page-independent ones from `next.config.js`):

- `Strict-Transport-Security` (2 years, preload), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `X-Permitted-Cross-Domain-Policies:
  none`.
- `Cross-Origin-Opener-Policy: same-origin` — no window handle across
  origins (external links open with `noopener`; there is no pop-up
  sign-in).
- `Cross-Origin-Resource-Policy: same-origin`, except what other sites may
  legitimately show: `/uploads/*`, `/images/*`, `/icons/*`, `/icon.svg`,
  `/favicon.ico` and the social cards (`/api/og`) are `cross-origin`.
  No `Cross-Origin-Embedder-Policy`: articles embed remote images and the
  video players, which do not opt in, and nothing here needs
  cross-origin isolation.
- `Permissions-Policy` — every powerful feature the site does not use is
  off for the page and every frame (camera, microphone, geolocation,
  payment, USB, serial, HID, Bluetooth, MIDI, sensors, screen capture,
  idle detection, local fonts, interest-based ad topics, …); passkeys
  (`publickey-credentials-get/create`) and the clipboard are `self`
  (the site only writes to it; the E2E suites read back what the copy
  buttons wrote); autoplay, encrypted media, full screen and picture-in-picture
  go to `self` and the three video-player origins only.
- Admin responses add `X-Robots-Tag: noindex, nofollow, noarchive` and
  `Cache-Control: no-store`.

**Content-Security-Policy** (enforced; `lib/csp.js` documents every
directive):

- `script-src 'self'` plus the SHA-256 of each inline script the pages
  render (the Trusted Types default policy, the theme and theme-colour
  pre-paint scripts, the tag filter's pre-paint) — no `'unsafe-inline'`
  and no scheme or host source. It does **not**
  include `'unsafe-eval'` in production either: articles are compiled to a
  tree on the server and rendered without evaluating code (only `next dev`
  adds it, for Fast Refresh).
  `lib/security/inlineScripts.ts` hashes the very constants the pages
  render, so a script and its hash cannot drift; a unit test fails when a
  page or component renders an inline script that is not listed, and when
  `'unsafe-inline'` or a scheme source reappears in `script-src`. Next's
  `__NEXT_DATA__` and the JSON-LD blocks are JSON data blocks, never
  executed. `script-src-attr 'none'`: inline event handlers never run.
- Why `'self'` and not nonces with `'strict-dynamic'`: static and ISR
  pages are one cached HTML file for every visitor and cannot carry a
  per-response nonce, and `'strict-dynamic'` would refuse Next's own
  `<script src>` tags. Nothing same-origin can be turned into a script:
  there is no JSONP endpoint, and uploads are images only, served with
  `nosniff` and a sandboxing CSP.
- `style-src 'self' 'unsafe-inline'` — Chakra UI renders through Emotion,
  which writes each page's styles into inline `<style>` elements on the
  server and inserts more at run time; next/font adds inline `@font-face`
  blocks and React renders `style` attributes. Their content differs per
  page and state, so hashes cannot list them, and static pages cannot
  carry nonces. CSS cannot run script.
- `img-src 'self' data: blob: https:` — a published article still embeds
  images from another host (checked against the live content store on
  2026-10-20: one post, four images on the project's own media host). The
  publish checklist offers to import remote images into `/uploads`; once
  none is left, `https:` can go. `media-src 'self'`, `font-src 'self'
  data:`, `connect-src 'self'`, `worker-src 'self'`, `manifest-src
  'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `frame-ancestors 'none'`, `frame-src` the three video-player origins
  only, `upgrade-insecure-requests`.
- Violations are reported to the site's own Errors panel (Admin → System
  → Errors): `report-to csp` with `Reporting-Endpoints: csp="/api/e"`
  (batched by the browser), and `report-uri /api/e` for browsers without
  the Reporting API. No third party receives them.

**Trusted Types, report-only** (`Content-Security-Policy-Report-Only:
require-trusted-types-for 'script'; trusted-types default nextjs
nextjs#bundler`): a plain string reaching a DOM-XSS sink (innerHTML,
script text or URL, `DOMParser` …) is reported and nothing is blocked. A
narrow default policy (`lib/trustedTypesDefault.ts`, the first inline
script) approves only what is safe by construction — HTML without `<`
(text cannot create elements), the same text between Cloudflare's
`email_off` comments, React's empty inert `<script>`, JSON as script text,
and this origin's `/_next/static/` chunk URLs — so the public pages report
nothing (an E2E test checks page loads, client-side navigations and the QR
panels; QR codes are drawn as SVG elements, not markup). What is still
reported is the work list before Trusted Types can be enforced: today the
admin rich-text editor (TipTap / ProseMirror) parsing the owner's own HTML
with `DOMParser` and `innerHTML`.

Not sent on purpose: `Clear-Site-Data` on logout. The session cookie is
already cleared by `Set-Cookie`, admin responses are `no-store` (nothing
to purge), `"cookies"` would also clear every cookie of the registrable
domain's other subdomains, and `"storage"` would delete the editors'
unsent drafts.

### Container runtime (`Dockerfile`, `docker-compose.yml`)

The image runs as the non-root user `nextjs` (uid 1001) under `dumb-init`.
Compose drops every Linux capability (`cap_drop: [ALL]`), sets
`no-new-privileges`, and limits the container to 256 processes/threads.
The root file system is writable on purpose: ISR rewrites prerendered pages under
`/app/.next/server`, which a read-only image would have to move to a
volume re-seeded on every deploy.

### Backups and restore drills

Snapshot manifests record a SHA-256 per file, the row counts and the schema
version. A weekly restore drill (`lib/restoreDrill.ts`) opens the newest
backup — the R2 copy when configured — in a scratch folder and checks the
archive, checksums, SQLite integrity, migrations, row counts and an article
render; failures show in Admin → System and the `/api/health` detail, and a
failed scheduled drill or backup is also sent to the owner (below).

The stores outside the content snapshots — `auth.db`, `audit.db`, `ai.db`,
`analytics.db` — are copied off the server sealed with AES-256-GCM under
`STORE_BACKUP_KEY` (`lib/storeBackup.ts`); the archive holds session rows,
passkey public keys, token hashes, sealed provider keys and the activity log,
so the key must stay secret and be kept off the server too. A separate
bucket with a write-only key keeps a leaked server key from deleting the
history. `.env` is never uploaded.

### Owner notifications (`lib/ops/alerts.ts`, `lib/ops/push.ts`)

Push channels are optional and set only in the server's environment
(`NOTIFY_*`). A notice holds a title, a short text and a link to an admin
page — for a contact message the sender's name and the subject, never the
address or the message; for an error its scrubbed name and message — and it
goes to the push service the owner chose, under that service's terms. A
public ntfy topic is readable by anyone who knows its name: use a long random
topic or a token. Requests go through `safeFetch` (public HTTPS addresses
only, no redirects, 5 s); a failure is logged by channel name, never by URL,
since a topic or bot token in a URL is a credential. The admin API reports
which channels are set, never their values.

### AI access

An MCP server for connected apps and an assistant that runs on the owner's
own model key share one tool layer, one permission model and one audit trail
(`lib/ai`, `lib/mcp`, `pages/api/mcp.ts`, `pages/api/oauth/*`,
`pages/api/admin/ai/*`; [README → AI](./README.md#ai-an-mcp-server-and-your-own-model)). Prompt
injection is unsolved, so every guarantee here is a server-side capability
limit, never prompt wording.

**The worst case.** A stolen token, a hijacked model and a hostile endpoint
share one: read published content (and drafts, if granted); leave drafts and
unpublished changes that visitors and review-link readers never see (at most
50 new drafts per app, each with Undo, the state before AI first touched a
document kept 90 days); spend budgets until they stop it. Nothing they do goes
public, runs code, reaches the inbox, analytics, error reports, keys or
sessions, or stalls the process.

- **Default off, three switches.** `AI_DISABLED=1` in the environment beats
  everything (it works with `auth.db` unreadable or the admin compromised);
  then *AI access* and *Allow connected apps* in `auth.db` (so a content
  restore cannot turn them on; unreadable counts as off); the public
  addresses also need `SITE_URL`. While closed, `/mcp`, `/oauth/*`,
  `/.well-known/oauth-*` and `/ai/review/*` answer exactly what an unknown
  path answers — status, body and every header, any letter case
  (`e2e/ai-public.spec.ts` compares them) — and the routes check again.
  Loosening a setting (on, longer retention, a higher token limit, saving
  drafts without asking, opening a pairing window, adding or replacing a key)
  needs the step-up; tightening never does. Off stops any answer being
  written, voids every waiting change and lists the schedules AI set so they
  can be cleared.
- **Tiers.** Scopes `content:read`, `content:draft`, `content:propose`; no
  wildcard, no admin scope, `tools/list` filtered by the token, a call above
  it `403 insufficient_scope`. Reads see the public view only: a hidden CV
  field, entry, photo or draft is indistinguishable from an unknown one, and
  everything outside the public view is byte-identical after a write. No
  tool exists for tokens, keys, settings, approvals, sessions, the inbox,
  analytics, error reports, logs, backups, mail, review links or CV share
  links. `tests/ai-boundary.test.ts` walks the **transitive** import graph of
  every tool and plan, the executor, the registry and the MCP wiring and
  fails if it reaches the inbox, analytics, error, log-buffer, backup, mailer
  or CV-share code, and checks that no tool imports a public writer (the
  approval path, the live content services, review links, R2, ORCID).
  `tests/ai-tools-leak.test.ts` fills every hidden place with sentinels and
  checks that no tool at any scope returns one.
- **The approval path and preview binding.** Every write that visitors or
  review-link readers could see is a proposal. The server stores its
  canonical arguments with their hash and builds the card — title, the
  complete public diff, every new external link and embed with flags, the
  public paths, Undo's reach — from the action and slug, never from model
  text (that appears only as a labelled quote, and Activity labels use the
  slug, not a model-written title). Approval is a cookie-only, same-site
  `POST` with the SHA-256 of the canonical preview the owner saw; the server
  then, in order: expires it after 7 days; refuses a different hash
  (`STALE_CARD`); voids it when the app that proposed it no longer has
  access; checks the stored arguments' hash; claims it once
  (`waiting → applying`, single use under concurrency); **re-plans the
  stored arguments against the current content and writes nothing if the new
  preview differs** (a moved redirect target, an alt text changed meanwhile,
  a photo hidden since); and only then executes. No model call happens
  between approval and execution. `destructive` changes (delete, restore,
  …) also need the step-up. Approve is armed only after the card has been
  visible a second with focus or the pointer inside it (DoubleClickjacking;
  `frame-ancestors 'none'` covers framing), and a long diff cannot be
  approved before it has been read to its end. There is no bulk approval.
- **Held items.** A draft or live item that is scheduled to publish, or one
  with an active review link, is never written directly by AI: the scheduler
  or the link would carry the edit to readers. Those edits become proposals
  (an app without `content:propose` is refused with `ITEM_SCHEDULED` or
  `ITEM_IN_REVIEW`), and `create_draft` never touches redirects or links
  (`SLUG_RESERVED`). The
  editor bridge goes through the same checks: a suggestion is shown as a
  diff, applied into the open editor as whole text bound to a hash, and
  written only by the owner's own save, which is attributed.
- **Every write is checked first** (`lib/ai/validate.ts`): edit arithmetic
  before any work (50 edits, 1,000 matches each, a 256 KiB result), a
  frontmatter allow-list with `draft` forced, remote images refused (a draft
  would fetch them for whoever opens it: an outbound channel), invisible and
  bidi control characters refused when added, new links flagged, and the MDX
  compiled in a worker thread with a memory limit, a 3-second wall clock, no
  resolver, no network, no database and no disk; it is respawned after a
  timeout or an out-of-memory, and there is no main-thread fallback. JSON-RPC
  batches are refused before any tool runs.
- **Tokens.** Personal tokens `pst_`, OAuth access `pso_` and refresh `psr_`:
  opaque (never a JWT), with an HMAC tag checked before the store is read, so
  a guessed token costs no lookup; stored as SHA-256 only, shown once;
  `Authorization: Bearer` only (a query-string token or a cookie alone is
  `401`); bound to the canonical MCP URL and to the session version.
  Personal tokens last 7–365 days, never forever; minting one or consenting
  to an app needs a verification within the last 2 minutes, so a cookie stolen
  inside the 10-minute step-up window cannot mint one silently. A token with a
  valid tag that is revoked, expired or from an old session is recorded as a
  theft signal; an invalid one writes nothing.
- **Sign out everywhere ends AI access.** So do a password reset and a
  password change that signs other browsers out (*Also end all AI apps* is
  ticked by default when it keeps them). Signing out another browser in
  Security revokes the apps that browser created and voids their waiting
  changes; the natural end of a session and signing out your own browser do
  not. A failed revoke is said, not hidden.
- **OAuth** (hand-written, `lib/ai/oauth.ts`, one test per rule in
  `tests/ai-oauth.test.ts`): issuer and resource from `SITE_URL`, never from
  `Host`; PKCE S256 only; exact redirect URIs at both steps (loopback
  port-agnostic, custom schemes refused); `iss` on every authorization
  response; single-use codes in the database (a replay revokes the grant);
  refresh rotation, where a rotated token used again past 10 seconds revokes
  the grant and mails the owner; access tokens 1 hour, grants 90 days and
  ended after 30 days unused. **Pairing** is the anti-phishing control: an app
  can be connected only inside a 10-minute window the owner opens for that
  app (step-up), and nothing public can tell whether one is open —
  `/oauth/authorize` and `/oauth/register` answer identically either way,
  store nothing and fetch nothing. All validation happens behind the
  owner's session; every failure before consent is a page on this site, never
  a redirect; a client ID metadata document is fetched only then, through
  `safeFetch` (5 KB, 3 s, exact `client_id`). The consent page leads with the
  redirect host, asks for the host to be typed unless it is an exact known
  pair, counts the requests that arrived in the window, shows no logos, and
  never remembers a consent. Cancel on an unknown host stays local.
- **Refresh tokens at a hosted vendor** (claude.ai, ChatGPT) live on that
  vendor's servers and cannot be sender-constrained: whoever holds one can
  use it until it rotates, is revoked or its grant ends. Low token privilege
  is the mitigation — the propose level can change nothing without the
  owner's approval — together with the session binding, the theft signals
  and Revoke in Connections.
- **Provider keys are sealed** (`lib/ai/secretBox.ts`): AES-256-GCM under a
  key derived from `AI_KEYS_SECRET` (a secret of its own, never derived from
  `JWT_SECRET`), with the row, the provider and the canonical base URL as
  associated data, so a database edit that points a key at another address
  fails to open it ("re-enter the key"). A stored key is never sent to an
  address from a request; the base URL is never a tool argument; a request
  carrying a key never follows a redirect; keys are opened per call, never
  returned to a browser, and scrubbed by exact value from errors, logs and
  provider messages (the Claude SDK runs with its logging off and a scrubbing
  logger). **The honest limit:** this protects a stray copy of `auth.db` and
  nothing stronger — the server's `.env` holds the secret, and
  `scripts/deploy.sh` backs both up together. Use a dedicated key with a
  spend limit at the provider; that, and Remove, are the real controls.
- **SSRF.** Every provider address the owner types and every client metadata
  document goes through `lib/security/safeFetch.ts`: public addresses only
  (loopback, private, link-local, metadata, CGNAT, the documentation and
  benchmark ranges, NAT64 and IPv4-mapped forms of them refused), one DNS
  answer vetted and pinned per request, credentialed requests never
  redirected, timeouts and byte caps. `AI_LOCAL_PROVIDER_ORIGINS` admits exact
  loopback origins (Ollama, LM Studio) only while `SITE_URL` is a loopback
  address; with a public host it is ignored and System health warns.
- **Requests to `/mcp`**: `POST` only; a plain-HTTP request with a public
  host is refused; `Host` must equal `SITE_URL`'s, `Origin` (when sent) must
  be the site, `claude.ai`, `claude.com`, `chatgpt.com`, `chat.openai.com`,
  `www.cursor.com` or `vscode.dev` (loopback only while local), never
  `checkCsrf`; a failed-authentication bucket charged only on failure (60 per
  10 minutes per client and per network, `429` before verification once
  spent, so valid traffic sharing an address is never throttled by it);
  bodies capped at 512 KB; `no-store` and `noindex` on everything.
- **Budgets**, persisted where a restart must not reset them: per app 60
  requests a minute and 600 an hour, 60 tool calls a minute, 30 writes an hour
  and 200 a day, 20 MB written a day, 50 AI drafts, 10 waiting changes; 20
  waiting site-wide (5 kept for the assistant); per item 30 AI writes an hour
  and 100 a day; 60 AI writes per 10 minutes site-wide; expensive reads 6 a
  minute site-wide. The assistant runs one answer at a time, stops after 16
  model steps, 40 tool calls or 300,000 weighted tokens, stops a model that
  repeats the same write, and has a daily token limit (code ceiling
  20,000,000). The owner is mailed when an app passes 80 % of a daily budget.
- **Audit, fail closed.** Every AI write inserts its activity row first and
  is refused (`AUDIT_UNAVAILABLE`) when that row cannot be written; the row
  names the actor (`AI · <app>`, `AI · <provider> · <model>`, and for
  approvals the approving browser); reads and refusals go to a separate
  30-day call log, so they cannot flush the activity log. The owner is mailed
  when AI access is turned on, an app is connected or first used, a refresh
  token is reused, a key is added, an app appears from a new country or a
  refused token keeps being tried (at most once per app, type and day).
- **Replies cannot leak.** Model output is rendered by an allow-list
  (`components/Admin/ai/ChatMarkdown.tsx`): no images, no raw HTML, no
  reference links, and only links to the site's own pages and editors are
  live (never `/api/`, `/oauth/`, `/ai/review/` or `/mcp`); everything else is
  text and nothing is prefetched (`tests/ai-render.test.ts`). The global CSP
  applies; there is no second policy.
- **Storage.** `data/ai.db` (conversations, changes, the call log, usage) is
  created `0600` with `secure_delete` on, never in a snapshot, R2 or a
  restore; `scripts/deploy.sh` copies it into its `0700` backup with the
  other stores. The state before an AI change keeps the whole document,
  hidden CV fields included, for 90 days for Undo, and is never sent to a
  browser or a model. Conversations are kept 90 days by default, or not at
  all.
- **The local trial** (`scripts/ai-trial.mjs`, [docs/ai-trial.md](./docs/ai-trial.md))
  refuses the main checkout and a public `SITE_URL`, blanks every R2, SMTP,
  Cloudflare, MongoDB, GitHub and provider credential in the server's
  environment, binds to `127.0.0.1` only and offers no tunnel.

## Operator responsibilities

This project ships secrets-free, but a deployment is only as safe as
its operator. After cloning:

1. Generate a real `JWT_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. Set `ADMIN_EMAIL` + `ADMIN_PASS` in `.env`. They're consumed on
   first boot to populate `data/admin.json`, then can be cleared.
   Change the password later in Admin → Security → Password (it never
   reads `ADMIN_PASS`); the card says while `ADMIN_PASS` still equals the
   live password — remove it from `.env` once it has changed.
   To revoke every session without changing the password, use **Sign out
   everywhere** in Admin → Security.
   Then register a passkey on two devices (Admin → Security), store the
   recovery codes offline, and turn on **Require a passkey**.
3. **Never commit `.env`.** It's already in `.gitignore`; double-check
   before your first push.
4. Rotate `GITHUB_TOKEN`, R2 keys, Mongo URI through the providers'
   dashboards on any deploy, even if the same values "look fine".
   Cleartext credentials in `.env` should never be reused across
   personal and production deployments.
5. Behind a proxy other than a cloudflared on the Docker host, set
   `TRUST_CLIENT_IP_HEADER` and `TRUSTED_PROXY_IPS` so rate limits see
   real client addresses; see `.env.example`. With both blank, the header
   is believed only from loopback and the container's default gateway.
6. Set `R2_REQUIRED=1` in production so the container refuses to start
   without a working off-site mirror (default = warn only).
7. Before turning AI on: set `AI_KEYS_SECRET` (`openssl rand -base64 32`)
   and `SITE_URL` in the server's `.env`, and give the assistant a
   dedicated provider key with a spend limit. AI access starts off; turn
   on only what you use (the assistant needs *AI access* only; connected
   apps also need *Allow connected apps*), keep app tokens at the lowest
   level that does the job, and revoke what you no longer use. On
   Cloudflare, check that the `/mcp`, `/oauth/*` and
   `/.well-known/oauth-*` paths are not challenged (Bot Fight Mode cannot
   be skipped per path; see `scripts/cloudflare-config.mjs`).
   `AI_DISABLED=1` is the emergency switch.
