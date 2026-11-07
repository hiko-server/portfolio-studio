#!/usr/bin/env bash
# MCP conformance against a local server (design §12.3). Run it with bash: zsh does not word-split.
#
#   MCP_CONFORMANCE_TOKEN=<pst_ token> scripts/mcp-conformance.sh http://127.0.0.1:<port> [proxy port]
#
# The server must be a real build on loopback with AI access and connected apps on, SITE_URL set to that
# origin, and the token a personal token of that server (read level is enough). The token is read from
# the environment, given to the loopback proxy (scripts/mcp-conformance-proxy.mjs) and never printed:
# the suite cannot send headers, and the product has no test bypass.
#
#   1. @modelcontextprotocol/conformance, spec 2026-07-28: server-stateless, http-header-validation,
#      caching, dns-rebinding-protection, tools-list, server-sse-multiple-streams, with the baseline
#      tests/mcp-conformance-baseline.yml (an unlisted failure and a stale entry both exit 1);
#      spec 2025-11-25: server-initialize, tools-list, ping; and the authorization server's
#      authorization-server-metadata-endpoint scenario (against the server itself: the document is public).
#   2. @modelcontextprotocol/inspector CLI through the proxy: tools/list in the legacy, auto and modern
#      eras (exit 0) and --strict on the real list (exit 0); straight to the server with no token and
#      --stored-auth-only (exit 3: the 401 path). The inspector runs with a throw-away HOME, so it never
#      reads or writes the owner's ~/.mcp-inspector; its connect timeout covers the proxy waiting out a 429.
#
# Exit 0 only when every step answered as expected. Dev-time tools through npx at exact versions, never
# in package.json.
set -uo pipefail

ORIGIN="${1:-}"
PROXY_PORT="${2:-4800}"
CONFORMANCE="@modelcontextprotocol/conformance@0.2.0-alpha.12"
INSPECTOR="@modelcontextprotocol/inspector@2.12.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$ROOT/tests/mcp-conformance-baseline.yml"

case "$ORIGIN" in
  http://127.0.0.1:[0-9]*|http://localhost:[0-9]*) ;;
  *) echo "Usage: MCP_CONFORMANCE_TOKEN=<token> $0 http://127.0.0.1:<port> [proxy port]" >&2; exit 2 ;;
esac
if [[ -z "${MCP_CONFORMANCE_TOKEN:-}" ]]; then
  echo "MCP_CONFORMANCE_TOKEN is not set (a personal token of that server)." >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcp-conformance.XXXXXX")"
NPM_CACHE="${npm_config_cache:-$HOME/.npm}"
PROXY_PID=""
cleanup() {
  if [[ -n "$PROXY_PID" ]]; then kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

node "$ROOT/scripts/mcp-conformance-proxy.mjs" "$PROXY_PORT" "$ORIGIN" > "$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
for _ in $(seq 1 50); do
  grep -q "conformance proxy on" "$WORK/proxy.log" 2>/dev/null && break
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then echo "The proxy did not start:" >&2; cat "$WORK/proxy.log" >&2; exit 1; fi
  node -e 'setTimeout(() => {}, 100)'
done
PROXY="http://127.0.0.1:$PROXY_PORT"

FAILED=0
RESULTS=()
record() { # name, expected exit, actual exit
  local verdict="ok"
  [[ "$3" == "$2" ]] || { verdict="FAILED"; FAILED=1; }
  RESULTS+=("$(printf '%-60s exit %-3s (expected %s) %s' "$1" "$3" "$2" "$verdict")")
}

run_scenario() { # spec version, scenario, use the baseline?
  local args=(npx -y "$CONFORMANCE" server --url "$PROXY/mcp" --scenario "$2" --spec-version "$1" -o "$WORK/results-$1-$2")
  [[ "$3" == "baseline" ]] && args+=(--expected-failures "$BASELINE")
  echo "== conformance $1 $2"
  "${args[@]}" 2>&1 | tee "$WORK/conformance-$1-$2.log" | grep -E "passed|failed|Passed|Failed|expected|Expected|warning|Warning|PASS|FAIL|✓|✗" | tail -n 40
  record "conformance $1 $2" 0 "${PIPESTATUS[0]}"
}

for s in server-stateless http-header-validation caching dns-rebinding-protection tools-list server-sse-multiple-streams; do
  run_scenario 2026-07-28 "$s" baseline
done
for s in server-initialize tools-list ping; do
  run_scenario 2025-11-25 "$s" plain
done

# The authorization server (stage M5): its metadata document, unattended, straight to the server (public, no
# token). authorization-code-grant waits for a person in a browser and needs a pairing window: e2e/ai-oauth.spec.ts
# drives that flow instead (design §12.3).
echo "== conformance authorization authorization-server-metadata-endpoint"
npx -y "$CONFORMANCE" authorization --url "$ORIGIN" --scenario authorization-server-metadata-endpoint -o "$WORK/results-authorization" 2>&1 \
  | tee "$WORK/conformance-authorization.log" | grep -E "passed|failed|Passed|Failed|warning|Warning|PASS|FAIL|✓|✗" | tail -n 40
record "conformance authorization authorization-server-metadata-endpoint" 0 "${PIPESTATUS[0]}"

# The inspector: a throw-away HOME, the shared npm cache.
inspector() {
  HOME="$WORK/home" MCP_CATALOG_PATH="$WORK/home/catalog.json" MCP_CLIENT_CONFIG_PATH="$WORK/home/client.json" npm_config_cache="$NPM_CACHE" \
    npx -y "$INSPECTOR" --cli --connect-timeout 90000 "$@"
}
mkdir -p "$WORK/home"
for era in legacy auto modern; do
  echo "== inspector tools/list, era $era"
  inspector "$PROXY/mcp" --transport http --protocol-era "$era" --method tools/list --format json > "$WORK/inspector-$era.json" 2> "$WORK/inspector-$era.err"
  code=$?
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const t = (r.tools || r.result?.tools || []).map((x) => x.name); console.log(`   ${t.length} tools: ${t.join(", ")}`)' "$WORK/inspector-$era.json" 2>/dev/null || tail -n 5 "$WORK/inspector-$era.err"
  record "inspector tools/list --protocol-era $era" 0 "$code"
done
echo "== inspector --strict"
inspector "$PROXY/mcp" --transport http --protocol-era auto --method tools/list --strict > /dev/null 2> "$WORK/inspector-strict.err"
code=$?
tail -n 5 "$WORK/inspector-strict.err"
record "inspector tools/list --strict" 0 "$code"
echo "== inspector --stored-auth-only, no token, straight to the server"
inspector "$ORIGIN/mcp" --transport http --stored-auth-only --method tools/list > /dev/null 2> "$WORK/inspector-noauth.err"
code=$?
tail -n 3 "$WORK/inspector-noauth.err"
record "inspector --stored-auth-only (no token: 401)" 3 "$code"

echo
echo "== results"
printf '%s\n' "${RESULTS[@]}"
exit "$FAILED"
