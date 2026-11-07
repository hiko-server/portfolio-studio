# Writing and the CV studio

Part of [Portfolio Studio](../README.md) · back to [What it does](../README.md#what-it-does)

This page is for the owner as editor: what the MDX bodies of posts and case studies accept, how the visual editor, translations, scheduling and review links work, how the CV's visibility switches, audiences and variants decide what each reader sees, how publications are rendered, and how to connect an ORCID iD. Paths name the code that holds each rule.

## Writing posts and case studies

Bodies are Markdown (GFM) with a small, eval-free set of MDX components (`lib/mdx.ts`, the rehype plugins under `lib/rehype/`). Beyond the usual Markdown:

| Write | Get |
|---|---|
| A YouTube or Vimeo link alone in its paragraph, bare or as a Markdown link | A click-to-load player. Its poster is copied once into `/uploads` when you save; nothing loads from the video host until the reader presses play |
| `> [!NOTE]` (or `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`) as the first line of a quote | A callout, labelled in the article's language |
| `![alt](/uploads/x.webp#wide)` / `#full`, or `<Figure size="wide" />` | A figure wider than the text column (full: edge to edge on phones). The figure's toolbar in the visual editor sets it |
| Two or more images in a row (blank lines between them, or one per line) | A gallery laid out by the images' shapes; identical captions are shown once |
| `[^1]` footnotes, `<details><summary>` blocks | Styled endnotes and a "deep dive" disclosure |

Case studies have an **At a glance** block in the editor (one-line outcome, up to four metrics with their source, team, publication date, extra links) and a cover focal point; the page shows only what is filled in. A new case study offers a documented template; its guidance notes are MDX comments that never reach the page, and the publish checklist points at any left behind. A post can name its case study (*Case study* field) — both pages then link to each other. Tags and stacks link to `/blog?tag=<tag>` and `/work?tag=<tag>`; `/work` ends with every public CV project (*All projects*), linked to its case study when there is one.

**The visual editor holds all of it.** Tables (rows, columns, column alignment, header row; Tab / Enter between cells), callouts (their type is a menu), videos (paste a YouTube / Vimeo link on an empty line), figures (caption under the image, an alt-text prompt, text / wide / full width) and anything else MDX — JSX components, notes, footnotes — which stays exactly as written, shown as an editable source block. Blocks move by their handle (drag, or its menu) and with Alt+↑ / ↓; pasted Markdown becomes structure. MDX → editor → MDX is lossless: the fixtures, every post of a local content store and 1,000 random documents per test run compile to the same page after a round trip (`components/Admin/RichEditor.tsx`, `components/Admin/editor/`, `e2e/editor-parity.spec.ts`). A post's cover gets a focal point too: social cards crop around it.

**Chinese and translations.** A post or case study in Chinese (detected, or set under *Language & translations* in the editor) gets Chinese interface words (日期 / 阅读 / ← 全部文章) and Chinese typesetting: a 34-character measure, 1.85 leading, spacing between Chinese and Latin text, emphasis dots. To publish the same piece in English and Chinese, give both versions the same **translation key** in that block (or press *Create draft* there to copy the saved version into a new draft in the other language, then translate it): each page then offers "阅读中文版" / "Read in English", search engines get hreflang alternates, and the lists show the piece once, in English (`lib/translations.ts`). Interface words live in `lib/uiStrings/`.

**Images.** Every image in a post or case study (and every Field Notes photo on the home page) opens a full-screen viewer that grows out of the picture and flies back into it: swipe between images, pinch or double-tap to zoom (the page itself never zooms), drag down to close; with a mouse, click to zoom and use the wheel; with the keyboard, arrows, + / − / 0 and Esc. The gesture engine is `components/Common/lightboxEngine.ts`, its maths `lib/lightboxGestures.ts` and `lib/lightboxPhysics.ts`.

Editing something that is already live never publishes half-done work: **Save changes** (⌘S) keeps the edits as *unpublished changes* — visitors see the published version — until **Publish changes…** (with a diff); Preview shows them at the real address (`lib/pendingRevisions.ts`). **Change…** next to the slug moves an item to a new address: the old one redirects permanently and every internal link is rewritten (`lib/slugRename.ts`, `lib/redirects.ts`). **Search & sharing** under the body sets the search title, language and "Mark as updated", and previews the Google result and the LinkedIn, X, WhatsApp, Slack and WeChat cards. The writing bar counts words (CJK per character), and offers find & replace (⌘F), focus mode and typewriter scrolling. **Admin → Tags & export** renames or merges tags across all items and downloads everything as a .zip of Markdown and JSON (`pages/admin/tags.tsx`, `pages/api/admin/export.ts`). Version history with rollback is `pages/api/versions.ts`.

**Publish later, share before.** *Publish… → Schedule…* sets when a draft — or the saved changes of a live item — goes live, and optionally when it unpublishes again; times are picked and shown in the site's time zone (`SITE_TIME_ZONE`, `lib/clock.ts`) and your device's, when it differs. The server does it on time with no browser open, catches up anything it missed while it was down, regenerates the pages, feeds and sitemap, and logs each action with *Scheduler* as the actor (`lib/schedule/`; the times live in the item's `publishAt` / `unpublishAt` frontmatter). *⋯ → Share for review…* makes a private link (1 hour to 30 days) that shows the draft read-only under a "Preview" watermark — never indexed or cached — counts how often it was opened, and can be turned off at any time (`lib/review/`, tokens signed and stored hashed in `auth.db`). **Admin → Scheduled & review links** (`/admin/publishing`) lists both.

## CV visibility model

All flags are optional, so existing CV data keeps working unchanged (`lib/cvVisibility.ts`):

| Level | Stored as | Effect |
|---|---|---|
| Section | `isVisible: false` | not on the A4 CV / PDF |
| Section | `showOnWebsite: false` | not on `/about` or the home page |
| Entry (any object in a list) | `isVisible: false` | hidden everywhere |
| Field | `hiddenFields: ["gpa"]` on the object | hidden everywhere |
| Bullet / tag | `hiddenItems: { "points": [2] }` on the parent | hidden everywhere |

Public pages call `readPublicCvData` (`lib/cvdata.ts`) with the audience and the surface they render; unauthenticated `GET /api/cvdata` returns the same pruned view. Only an admin session gets the full document, through `/api/admin/cvdata`.

Publication rules hold whatever the switches say: the PDF-only photo of Personal Info (`photo`, `photoOnPdf`) is removed from every public view and read separately by the server-side PDF, a recommendation is public only when its `permission` is `true`, and the Studio's dismissed readiness checks (`readinessDismissed`) never leave the admin.

## Audiences and variants

Besides the eye, every field, entry, list and section has **Shows on**: public pages, downloads (PDF / text / JSON Resume / vCard) and private links, so a phone number can stay off `/cv` and `/api/cvdata` but be in the PDF; hidden always wins. CV bullets have their own *Shows on* menu next to the eye.

Under Dashboard → CV → *Variants & links* (`/admin/dashboard?tab=cv&view=variants`) the owner names variants ("Machine learning", "Embedded") that pick and order sections and entries, with a page target measured on the real PDF, and shares one through a signed, expiring, revocable private link (`/cv/r/<token>`, stored as a hash, noindex / no-store / no-referrer) with its PDF (`/cv/r/<token>/en.pdf`, `/cv/r/<token>/zh.pdf`); each link shows only an open count and the day of the last open. At most 24 variants are kept (`MAX_VARIANTS`, `lib/cvVariants.ts`); the links live in `auth.db` (`lib/cvShare/`). Logic in `lib/cvVisibility.ts`, `lib/cvVariants.ts`, `lib/cvShare/`.

The CV itself is downloadable as a server-rendered, tagged PDF with embedded fonts (`/cv.pdf`, `/cv/zh.pdf`; `lib/cvExport/pdf.ts` with pdfkit, Geist and a Noto Sans SC subset from `assets/pdf`), plain text (`/cv.txt`) and JSON Resume 1.0.0 (`/cv.json`; `lib/cvExport/jsonResume.ts`). CV Studio's recruiter-readiness checks are `lib/cvReadiness.ts` (`/admin/dashboard?tab=cv&panel=readiness`), skill evidence `lib/skillEvidence.ts`.

## Publications

A CV section for papers, preprints and theses (authors in order, venue, status, DOI, links, abstract), rendered in citation style on `/cv`, `/cv/zh`, the Reading view, the A4 sheet and the downloadable CVs (PDF in EN and 中文, plain text, JSON Resume `publications`), and on `/publications` with BibTeX / APA copy and ScholarlyArticle JSON-LD. The home page can show **Selected Publications** (an owner-ordered section, after projects by default), the /about rail links the list with its count, ⌘K finds every paper, a paper's keywords count as skill evidence, the Home editor suggests published papers as proof-strip tiles (verbatim), and CV Studio's readiness checks flag a published paper without venue, date or DOI / link and a paper "under review" for more than 18 months. The owner's own name is emphasised from the public Personal Info; anything not yet published carries its real status; a hidden co-author shows as an ellipsis so the author order stays true. Nothing is public (no section, no nav link, `/publications` answers 404) until a public paper exists. Logic in `lib/publications/`.

## Connect your ORCID iD

The owner's ORCID iD is a Personal Info field in CV Studio (checked with ORCID's MOD 11-2 checksum; a pasted `https://orcid.org/<id>` link is stored as the bare iD) with the usual eye toggle. Once set it appears as ORCID's display guidelines ask — the green iD icon and the full `https://orcid.org/<id>` link — on `/cv`, `/cv/zh`, `/publications` and the /about rail, as a text link in the PDF and plain-text CVs, as a JSON Resume profile, in the vCard, in the Person JSON-LD (`sameAs` + an ORCID `identifier`, and the papers' author `@id`) and as one line of `/llms.txt`; hidden, it appears nowhere. **Import from ORCID** in the Publications section lists the record's public works (read on the server from ORCID's public API, nothing stored), marks the ones already on the CV (same DOI or title) and adds the ticked ones as papers to review before saving. Logic in `lib/orcid/`.

ORCID's iD display guidelines show an iD the researcher proved by signing in to ORCID with the green iD icon, and one that was only typed in with the unauthenticated iD icon followed by "(unauthenticated)" ("（未经认证）" on Chinese pages). CV Studio → Personal Info has **Connect your ORCID iD** next to the iD field; the site shows the authenticated form once it was used. The button stays disabled until the server has an ORCID client:

1. Sign in at ORCID (the record must have a verified e-mail address), open **Developer Tools** from the account menu (`https://orcid.org/developer-tools`), accept the Public API terms and **Register for ORCID Public API credentials** — it is free. Name: the site's name; website: the site's URL; description: what the connection is for (ORCID shows these on its sign-in screen).
2. Add the redirect URI exactly as the site sends it: the origin of `SITE_URL` plus `/api/admin/orcid/callback` — for a site at `https://example.com` that is `https://example.com/api/admin/orcid/callback` (ORCID accepts only https redirect URIs in production).
3. Put the **Client ID** (`APP-...`) and **Client secret** in the server's environment as `ORCID_CLIENT_ID` and `ORCID_CLIENT_SECRET` and restart. To try it first, register a client at `https://sandbox.orcid.org/developer-tools` (test records; plain-http redirect URIs such as `http://127.0.0.1:3000/api/admin/orcid/callback` are accepted there, with `SITE_URL` set to that origin) and set `ORCID_ENV=sandbox`.

How it works (`lib/orcid/oauth.ts`, `flow.ts`, `connectRoute.ts`): the button is a plain link to `GET /api/admin/orcid/connect`, which sends a signed-in admin to ORCID's OAuth sign-in (authorization code, scope `/authenticate` only — no access to the record) with a random `state` bound to that admin session in a signed, single-use, 10-minute, HttpOnly `SameSite=Lax` cookie scoped to the callback. ORCID sends the browser back to `GET /api/admin/orcid/callback`; the admin session cookie is `SameSite=Strict` and does not come along on that cross-site navigation, so the proxy lets this one route through and the route authorises itself: the state must match the cookie, be used once and come from a session that is still live and current. The server exchanges the code at ORCID's token endpoint (the secret never reaches the browser; the request goes through `safeFetch` to the one ORCID host, never redirected), stores the confirmed iD in both languages' Personal Info with the marker `orcidAuthenticated: { id, at }`, records it in the activity log and discards the access token. It answers a tiny page that opens the Studio (a same-origin step, so the Strict cookie is sent again) with a toast. ORCID does not offer PKCE for this flow (its OpenID configuration lists no `code_challenge_methods_supported`); the confidential client and the session-bound state cover what PKCE would.

The marker belongs to the server: a save keeps it only while the CV still carries it with the same iD, so editing the iD by hand makes it unauthenticated (Undo in the Studio brings it back before saving), and a marker typed into the JSON is ignored. **Disconnect** removes the marker and keeps the iD (now shown as unauthenticated); clearing or hiding the field is an ordinary edit. Public pages receive the marker only as `{ id }` and only while the iD is public; the PDF, text and JSON CVs, the vCard and the JSON-LD carry the iD's URI either way.

<img src="../docs/screenshots/admin-cv-studio.png" width="900" alt="CV Studio: section list, Personal Information form with per-field eye toggles, live A4 preview">
