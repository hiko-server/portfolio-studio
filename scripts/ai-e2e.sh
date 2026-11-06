#!/usr/bin/env bash
# AI end-to-end gate: the two AI Playwright projects against the STANDALONE
# server, on synthetic fixtures, next to the fake model provider
# (design §12.4, docs/ai-trial.md).
#
#   scripts/ai-e2e.sh [--keep] [--project <name>]... [-- <playwright args>]
#
# Prerequisite, once: yarn playwright install chromium firefox
#
#   1. copy     this checkout's tracked files and working-tree changes into a
#               temp tree, with its own copy of node_modules; never data/,
#               public/uploads, the owner's photos or an env file (.env*: git
#               ignores only .env and .env*.local, and Next would load
#               .env.production into the build and the standalone server)
#   2. fixtures scripts/ci/fixture-store.mjs (before the build: it refuses
#               NODE_ENV=production)
#   3. build    next build --webpack with credentials unset, then public/ and
#               .next/static copied into the standalone directory
#   4. start    tests/helpers/fake-llm.mjs and .next/standalone/server.js on
#               loopback, with throw-away secrets and AI_LOCAL_PROVIDER_ORIGINS
#   5. run      the projects, ai-admin (Chromium) then ai-consent-firefox, one
#               after the other; each one's result is reported
#
# The temp tree goes away on success. After a failure, or with --keep, it stays
# for the Playwright report and the server log, and its path is printed.
# Secrets are generated for this run and never printed.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

KEEP=0
PROJECTS=()
PW_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --project) PROJECTS+=("$2"); shift ;;
    --) shift; PW_ARGS=("$@"); break ;;
    *) echo "usage: scripts/ai-e2e.sh [--keep] [--project <name>]... [-- <playwright args>]" >&2; exit 2 ;;
  esac
  shift
done
[ "${#PROJECTS[@]}" -gt 0 ] || PROJECTS=(ai-admin ai-consent-firefox)

step() { printf '\033[1m[ai-e2e]\033[0m %s\n' "$*"; }

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (process.versions.modules !== "127" || major !== 22 || minor < 18) {
    console.error(`[ai-e2e] Node 22 at 22.18 or later (ABI 127) is required; this is ${process.versions.node}. See .nvmrc.`)
    process.exit(1)
  }'
[ -d node_modules/next ] || { echo "[ai-e2e] no node_modules here: run yarn install --frozen-lockfile" >&2; exit 1; }

# The server and the build must not see anything that reaches another system.
for name in $(compgen -e | grep -E '^(R2_|SMTP_|CF_|ANTHROPIC_|OPENAI_)|^(INDEXNOW_KEY|MONGODB_URI|GITHUB_TOKEN|NEXT_PUBLIC_SITE_HOST|AI_DISABLED)$' || true); do
  unset "$name"
done

# A free port above 3600 on loopback (3002 stays the owner's trial).
free_port() {
  node -e '
    const net = require("net")
    const tryPort = (p) => {
      const s = net.createServer()
      s.once("error", () => tryPort(p + 1))
      s.listen(p, "127.0.0.1", () => s.close(() => console.log(p)))
    }
    tryPort(Number(process.argv[1]))' "$1"
}
secret() { node -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1])).toString(process.argv[2]))' "$1" "$2"; }

WT="$(mktemp -d "${TMPDIR:-/tmp}/ai-e2e.XXXXXX")"
WT="$(cd "$WT" && pwd -P)"
SERVER_PID=""
FAKE_PID=""
STATUS=1
cleanup() {
  [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true
  [ -z "$FAKE_PID" ] || kill "$FAKE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  if [ "$STATUS" -eq 0 ] && [ "$KEEP" -eq 0 ]; then
    rm -rf "$WT"
  else
    echo "[ai-e2e] kept: $WT (server.log, fake.log, playwright-report/, test-results/)"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step "copy -> $WT"
# Tracked files plus untracked-but-not-ignored ones (new files of the change under test).
git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  # No env file but the tracked example, which Next never reads.
  case "$f" in .env.example) ;; .env*) continue ;; esac
  mkdir -p "$WT/$(dirname "$f")"
  cp -p "$f" "$WT/$f"
done
rm -rf "$WT/data" "$WT/content" "$WT/public/uploads" "$WT/public/images/imageScroller"
mkdir -p "$WT/data"
git show HEAD:data/home.json >"$WT/data/home.json"
git show HEAD:data/cvdata.json >"$WT/data/cvdata.json"
# A real copy, not a symlink: the standalone tracer needs node_modules inside
# the project root. APFS and reflink filesystems clone it almost for free.
cp -cR node_modules "$WT/node_modules" 2>/dev/null || cp --reflink=auto -R node_modules "$WT/node_modules" 2>/dev/null || cp -R node_modules "$WT/node_modules"

cd "$WT"

step "fixture store"
env -u NODE_ENV node --import ./tests/register.mjs scripts/ci/fixture-store.mjs

PORT="$(free_port "${AI_E2E_PORT:-3610}")"
FAKE_PORT="$(free_port "$((PORT + 1))")"
BASE="http://127.0.0.1:$PORT"
FAKE="http://127.0.0.1:$FAKE_PORT"

step "build"
env -u NODE_ENV NEXT_TELEMETRY_DISABLED=1 SITE_URL="$BASE" LINK_CHECK_INTERVAL_HOURS=0 node_modules/.bin/next build --webpack >build.log 2>&1 || { tail -n 60 build.log; exit 1; }
[ -f .next/standalone/server.js ] || { echo "[ai-e2e] the build made no standalone server" >&2; exit 1; }
cp -R public .next/standalone/
mkdir -p .next/standalone/.next
cp -R .next/static .next/standalone/.next/

ADMIN_EMAIL="owner@example.test"
ADMIN_PASS="$(secret 18 base64url)"
JWT_SECRET="$(secret 32 hex)"
AI_KEYS_SECRET="$(secret 32 base64)"
export ADMIN_EMAIL ADMIN_PASS

step "start the fake provider on $FAKE and the standalone server on $BASE"
node tests/helpers/fake-llm.mjs --port "$FAKE_PORT" >fake.log 2>&1 &
FAKE_PID=$!
(
  cd .next/standalone
  exec env \
    NODE_ENV=production HOSTNAME=127.0.0.1 PORT="$PORT" SITE_URL="$BASE" \
    JWT_SECRET="$JWT_SECRET" AI_KEYS_SECRET="$AI_KEYS_SECRET" \
    AI_LOCAL_PROVIDER_ORIGINS="$FAKE" LINK_CHECK_INTERVAL_HOURS=0 \
    node server.js
) >server.log 2>&1 &
SERVER_PID=$!

up=0
for _ in $(seq 1 90); do
  if curl -fsS --noproxy '*' -o /dev/null "$BASE/api/health" 2>/dev/null && curl -fsS --noproxy '*' -o /dev/null "$FAKE/__fake/health" 2>/dev/null; then up=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
[ "$up" = 1 ] || { echo "[ai-e2e] the servers did not come up" >&2; tail -n 40 server.log >&2; exit 1; }

# Loopback only, never 0.0.0.0 (F19).
node -e '
  const net = require("net"), os = require("os")
  const port = Number(process.argv[1])
  const others = Object.values(os.networkInterfaces()).flat().filter((i) => !i.internal && i.family === "IPv4").map((i) => i.address)
  let open = 0
  Promise.all(others.map((host) => new Promise((done) => {
    const s = net.connect({ host, port })
    s.setTimeout(1000)
    s.once("connect", () => { open++; console.error(`[ai-e2e] the server answers on ${host}`); s.destroy(); done() })
    s.once("timeout", () => { s.destroy(); done() })
    s.once("error", done)
  }))).then(() => process.exit(open ? 1 : 0))' "$PORT"

# The standalone server's stores (its cwd is .next/standalone): specs that switch
# a server setting (AI access, e2e/ai-public.spec.ts) write there.
export E2E_SERVER_DATA_DIR="$WT/.next/standalone/data"

PASSED=()
FAILED=()
for project in "${PROJECTS[@]}"; do
  step "playwright: $project"
  if E2E_BASE_URL="$BASE" E2E_FAKE_LLM_URL="$FAKE" node_modules/.bin/playwright test -c e2e/playwright.config.ts --project="$project" --reporter=list ${PW_ARGS[@]+"${PW_ARGS[@]}"}; then
    PASSED+=("$project")
  else
    FAILED+=("$project")
  fi
done

step "passed: ${PASSED[*]:-none}"
if [ "${#FAILED[@]}" -gt 0 ]; then
  step "FAILED: ${FAILED[*]}"
  exit 1
fi
STATUS=0
