# The admin studio, page by page

Part of [Portfolio Studio](../README.md) · back to [What it does](../README.md#what-it-does)

This page is for the owner inside `/admin`: every admin page and what it does, the home page's section switches, the GitHub data and organizations behind the open-source band, the currently-coding chip, the analytics views, the contact inbox and content health. The writing tools and the CV studio have their own page, [docs/authoring.md](authoring.md); backups, health and the activity log are in [docs/operations.md](operations.md); AI is in [docs/ai.md](ai.md).

## Admin pages

| Route | Purpose |
|---|---|
| `/admin/login` | Sign-in (covert: no nav link; reachable via the ⌘K palette or the URL) |
| `/admin/forgot` + `/admin/reset` | E-mail-based reset flow |
| `/admin` | Status hub: what needs attention, live counts, links to the editors |
| `/admin/dashboard?tab=home` | Home editor — hero, highlights (the proof strip, up to four), section order and visibility, availability (job intent, work authorisation), brands, photos, contact form copy and reason kinds, open source (GitHub organizations, featured repositories) |
| `/admin/dashboard?tab=cv` | CV Studio (per-field visibility, hidden-items panel, recruiter-readiness checks — `&panel=readiness`, A4 / website preview), `&view=raw` (the raw JSON editor) and `&view=variants` (variants and private links) |
| `/admin/dashboard?tab=versions` | Version-history rollback |
| `/admin/dashboard?tab=storage` | SQLite + R2 inventory, *Backup now*, *Pull latest* |
| `/admin/dashboard?tab=inbox` | Contact Inbox — folders, kinds, search (every word must match; `is:unread`, `is:starred`, `is:replied`, `kind:<kind>` narrow it), star / archive / replied, threaded replies with EN / 中文 templates, delete with Undo |
| `/admin/dashboard?tab=analytics` | First-party page views, referrers, devices, real-user Web Vitals, goals, Source → CV → Download and searches with no results |
| `/admin/blog`, `/admin/blog/edit?slug=<slug>` | Blog post manager: drafts, unpublished changes of live posts, publish checklist, live preview, history, slug change with redirect, search & sharing previews |
| `/admin/work`, `/admin/work/edit?slug=<slug>` | Case-study manager (the same tools) |
| `/admin/tags` | Rename, unify or merge post tags and case-study tech; content export (.zip) |
| `/admin/media` | Media library: uploads with where they are used, default alt text and captions, replace, the trash (`?view=trash`), R2 check |
| `/admin/publishing` | Scheduled & review links: what publishes or unpublishes on its own, the scheduler's state, every active review link |
| `/admin/now`, `/admin/uses`, `/admin/about` | One-off page editors (`about` = the bio on /about; empty = no bio section) |
| `/admin/db-config` | MongoDB connection + manual backup / restore |
| `/admin/security` | Passkeys, recovery codes, password change, "Require a passkey", signed-in browsers, sign-in history |
| `/admin/system` | Health (build, disk, notifications ([what is set up, and a test notice](operations.md#owner-notifications)), databases, backups, restore drill, recent warnings), `?view=content` (content health), `?view=errors` and `?view=activity` (the activity log) |
| `/admin/ai` | AI: the assistant (default), `?view=changes` (what AI proposed and did; approve, reject, undo; every tool call), `?view=connections` (the switches, connecting an app, personal tokens, connected apps) and `?view=models` (model keys, the assistant's settings, usage, what leaves the site) |
| `/admin/ai/change/<id>` | One AI change: its card, the whole diff and a preview |
| `/admin/ai/connect` | The OAuth consent page a connecting app sends you to |

Press `?` on any admin page for the keyboard shortcuts (searchable). The admin is keyboard-first: ⌘K / Ctrl+K lists every admin page and the actions of the view on screen (an admin view adds its own with `useAdminCommands`, `components/Admin/shell/useAdminCommands.ts`); `G` then a letter jumps — `D` overview, `I` Inbox, `R` CV Studio, `E` Home editor, `P` posts, `O` case studies, `M` media, `T` analytics, `V` versions, `F` storage, `S` System health, `L` activity, `Q` content health, `X` errors, `K` security, `Y` scheduled & review links, `J` AI assistant (`components/Admin/shell/adminCommands.ts`; the public `G H/A/W/B/C/N/U` work too); lists take `j` / `k`, `Enter`, `x` and their own letters (Inbox: `r` reply, `s` star, `e` archive, `u` unread, `#` delete, ⌘Z undo). Single-letter keys follow the *Single-key shortcuts* switch.

Every admin page is served with `X-Robots-Tag: noindex, nofollow, noarchive` and `Cache-Control: no-store`; the proxy gate and the sign-in controls are described in [SECURITY.md → Authentication and sessions](../SECURITY.md#authentication-and-sessions).

<img src="../docs/screenshots/admin-home.png" width="900" alt="Home editor: Sections block with visibility checkboxes, drag handles and the Recruiter-first order button">

## Section visibility

Each home section is gated through `isSectionVisible(home, key)` (`lib/homeShape.ts`) where `key` is one of `introduction`, `highlights`, `brands`, `open-source`, `tech-stack`, `activity`, `projects`, `publications`, `writing`, `experience`, `certifications`, `photos`, `contact`. A missing key defaults to *visible* — a clean install keeps the full page. The numbered sections follow `home.sectionOrder`, read through `resolveSectionOrder` (`lib/homeSections.ts`): unknown keys are dropped and a section missing from a stored order is inserted at its default place, so an older document never hides a section.

Toggle and reorder from **Admin → Home → Sections** (*Recruiter-first* puts projects, experience, publications, writing and skills before the GitHub activity; `RECRUITER_SECTION_ORDER` in `lib/homeSections.ts`).

## GitHub data and organizations

The Open Source band, the activity feed and the admin's featured-repo picker read GitHub on the server (`lib/githubData.ts`; the browser never calls GitHub). The login is the GitHub link under **Admin → Home → Socials**. Repositories are that account's public ones **plus** the public repositories of the GitHub organizations listed under **Admin → Home → Open source → Organizations** (`home.openSource.orgs`, at most 10). Organizations are never added from memberships: list only the ones whose work is your own. Adding one checks it on GitHub (`GET /api/admin/github-org`: its display name and repository count, or "not found", the rate limit, GitHub unavailable) and offers its repositories in the picker as `org / name`; the saved ones show what the site's own list of them says when the editor opens (no GitHub lookup, so reopening the editor costs no request). Removing one can be undone from its toast.

- **What counts** — the same rule for the personal account and every organization: public repositories only, no forks, no dot-named repositories (`.github`); archived ones count. The *Public repos* and *Total stars* tiles describe exactly that set, and the language bar and the activity fallback (when the 90-day event feed is empty) use it too.
- **Featured repositories** — a personal repository is stored by its name, an organization's as `org/name` (the owner a GitHub login, the name up to 100 characters). A plain name always means the personal repository (a fork too), even when an organization has one with the same name; with no personal one, the first organization in the list. The editor resolves names exactly like the page and says when a featured repository's organization is no longer in the list.
- **On the page** — an organization's repository card reads `example-org / name`; on a narrow card the name moves to a line of its own under `example-org /` instead of being cut. Personal cards are unchanged.
- **Failures** — an organization that is renamed, deleted or unreachable is skipped (and logged once) while everything else still shows; only the personal list failing makes the band say GitHub is unavailable.
- **Caching** — each list (personal, each organization) and each repository's languages is its own in-memory entry with stale-while-revalidate, so a change of the organizations loads only what is new, and a save or a restore (Home editor, Versions, MongoDB backup) loads the new lists before the pages regenerate (then purges `/api/github/*` from Cloudflare when configured).
- **The rate limit is enforced, not estimated** — without a token GitHub allows 60 requests an hour per IP. `ghFetch` (`lib/github.ts`) never sends more than 45 in any 60 minutes, and a background refresh (the last value is served meanwhile) only while fewer than 30 went out; GitHub's own `x-ratelimit-remaining` counts when it is lower. A request without room is not sent: the last value stays, or that part waits. The TTLs (`GH_TTL`, `lib/githubData.ts`) average about 23 requests an hour at ten organizations, but entries loaded together expire together (a cold start loads 43 at once; the 30 repositories' languages fall due together every 12 hours), so the bound, not the average, is what holds the worst hour — `tests/github-budget.test.ts` simulates those hours. A `GITHUB_TOKEN` raises the limit to 5000 (the same shares apply) and enables the GraphQL contribution calendar.

## Currently-coding chip

Three-line chip under the hero avatar (`label / project / note`). Each field independently follows **admin → CV → blank** precedence:

- If the operator typed something, that wins.
- Otherwise the helper in `lib/currentlyCoding.ts` derives a value from the CV document in the content store (the tracked `data/cvdata.json` is only the demo seed): `label` → `"currently coding"`; `project` → the "most relevant current" `workExperience.companyName` (prefers ongoing roles by start date ascending; falls back to the most recently ended); `note` → `"since <earliest year>"` across all dated CV entries.
- The whole chip hides only when all three merged values are empty.

The admin editor surfaces the auto-derived values as input placeholders plus a small `Auto-derived now:` footer, so the operator always knows what visitors will see if they leave a row blank.

## Exploring the numbers

Admin → Analytics: pick a period (presets, a custom range, ‹ › to step back and forth) and *Compare* to draw the period before it; filter by page, referrer, country, device, browser or page language from the Filter picker or by clicking any row — every card, the goals, the conversion, the *Paths to a goal* and the Web Vitals (page and device only) follow, and the URL keeps the view. Filters read the raw rows, so a filtered view covers the last 35 days at most and says so; without filters the whole period comes from the daily totals. Filtering to one page adds its detail (read to the end, e-mail and outbound clicks, its Web Vitals); the post editor's ⋯ menu links to it. *Export* downloads the view as CSV (one table, or all of them in a .zip — never the search texts), and the *Weekly digest* e-mails last week's totals to `NOTIFY_EMAIL` every Monday (from 01:00 UTC; `lib/analytics/digestSchedule.ts`) once switched on — it needs SMTP, and the card says how to set it up. Nothing new is stored about visitors; analytics migration 7 only adds two indexes and a daily page-language total. What is recorded, and for how long, is on the README's [Privacy and security](../README.md#privacy-and-security) section.

## Contact messages

- The form says what is kept and for how long, next to the Send button. A message (name, e-mail, subject, message and the optional structured details: reason, kind, company, a link, a timeline) is stored in `data/contact-inbox.jsonl` and, with SMTP, e-mailed to the owner. The link is https-only and never fetched by the server. The form carries a signed single-use nonce (at least 2 s between load and send), a small sum and a honeypot, no external captcha (`pages/api/contact.ts`, `pages/api/contact/nonce.ts`, `lib/security/contactChallenge.ts`); the inbox accepts at most 300 messages per UTC day site-wide (`lib/inbox.ts`).
- In Admin → Inbox each message can be starred, archived, marked replied and answered by e-mail. A reply is sent **from the SMTP account's own address** (so it passes the recipient's DMARC check — a domain with `p=reject` would have it refused if it came "from" the domain through another provider) with **Reply-To** set to the e-mail the site shows, and it threads with the notification you received (Message-ID, In-Reply-To, References). Templates (English and 中文, placeholders `{firstName}` `{name}` `{subject}` `{me}`) are content and live in the content store; statuses and the replies you sent stay on the server next to the inbox and are forgotten with the message. Without SMTP the composer explains the setup and opens the same draft in your mail app (`lib/inboxReply.ts`, `lib/inboxTemplates.ts`).
- Messages older than `CONTACT_RETENTION_DAYS` (default 365) are deleted by a nightly job at 19:00 UTC (`lib/inboxRetention.ts`); listings hide them before that, a restore never merges them back, and full-site snapshots older than the period are pruned too (the newest one is always kept). The deploy script's per-deploy backups (`$BACKUP_ROOT/<timestamp>/` on the server, the ten newest; `scripts/deploy.sh`) also hold a copy of `data/` and rotate by count.

## Content health

Admin → System → Content (`/admin/system?view=content`, summarised on Health): every published post, case study and page, the CV and the home page are checked for broken or moved links (a daily, polite external-link check through `safeFetch` — HEAD first, one request per site at a time, results in `data/content-health/links.json`; LinkedIn's 999 and bot walls count as "couldn't verify", never broken; the schedule is `LINK_CHECK_INTERVAL_HOURS`, default 24), links to missing or draft posts, tracking parameters in links, images that are missing, hot-linked from another site, too large, without responsive sizes or with a file name for alt text, heading structure, duplicate or missing descriptions and hard line breaks. Safe fixes are one click — strip tracking parameters, import a remote image into uploads, generate responsive sizes, use a link's new address, remove a stray break — and go through the editor's own save path (version snapshot, R2 mirror, page revalidation, refused with 409 when the item changed since the report); anything that needs your words links to the editor. `j` / `k` move through the issues, `f` applies the focused fix.
