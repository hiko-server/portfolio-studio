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
