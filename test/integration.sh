#!/usr/bin/env bash
#
# CacheNest integration test suite.
#
# Validates the proxy against a running Docker deployment:
#   1. Health and route reachability
#   2. Cold install  -> upstream fetches (cache misses) + blobs written to disk
#   3. Warm install  -> zero upstream fetches (cache hits) + faster completion
#   4. Volume persistence across `docker compose restart`
#
# The tests never touch global npm/pip configuration: every client runs inside
# a throwaway temp directory with its own npm cache.
#
# Usage:
#   bash test/integration.sh
#   npm run test:integration
#
# Environment overrides:
#   CACHENEST_URL                 Proxy base URL           (default http://localhost:8787)
#   CACHENEST_DATA_DIR            Host cache directory     (default <repo>/data)
#   CACHENEST_TEST_NPM_PACKAGE    npm package to install   (default is-odd)
#   CACHENEST_TEST_NPM_VERSION    npm package version      (default 3.0.1)
#   CACHENEST_IT_KEEP=1           Keep temp dirs for debugging
#
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

BASE_URL=${CACHENEST_URL:-http://localhost:8787}
DATA_DIR=${CACHENEST_DATA_DIR:-$ROOT_DIR/data}
SERVICE=${CACHENEST_SERVICE:-cachenest}
TARBALL_PKG=${CACHENEST_TEST_NPM_PACKAGE:-is-odd}
TARBALL_VERSION=${CACHENEST_TEST_NPM_VERSION:-3.0.1}
KEEP=${CACHENEST_IT_KEEP:-0}

COMPOSE=(docker compose --project-directory "$ROOT_DIR" -f "$ROOT_DIR/docker-compose.yml")

# ---------------------------------------------------------------- logging ----

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'
  C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_BLUE=''; C_GREEN=''; C_RED=''; C_DIM=''
fi

step() { printf '\n'; printf '%s==> %s%s\n' "$C_BLUE" "$*" "$C_RESET"; }
info() { printf '%s    %s%s\n' "$C_DIM" "$*" "$C_RESET"; }
pass() { printf '%s    PASS%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
die()  { printf '%s    FAIL%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# --------------------------------------------------------------- utilities ---

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

run_id() {
  node -e 'process.stdout.write(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)'
}

count_blobs() {
  find "$DATA_DIR/blobs" -type f 2>/dev/null | wc -l | tr -d ' '
}

dir_size_kb() {
  du -sk "$DATA_DIR" 2>/dev/null | awk '{ print $1 }'
}

# Emit "hits misses saved_bytes" from /metrics.
snapshot() {
  local out
  if ! out=$(curl -fsS --max-time 10 "$BASE_URL/metrics" \
    | awk '
        $1 == "cachenest_cache_hits_total"            { h = $2 }
        $1 == "cachenest_cache_misses_total"          { m = $2 }
        $1 == "cachenest_bandwidth_saved_bytes_total" { b = $2 }
        END {
          if (h == "" || m == "") exit 1
          printf "%d %d %d\n", h, m, b + 0
        }')
  then
    die "cannot read $BASE_URL/metrics (is the container running?)"
  fi
  printf '%s\n' "$out"
}

wait_for_health() {
  local attempts=${1:-60} i
  for i in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 3 "$BASE_URL/health" 2>/dev/null | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

human_kb() {
  awk -v kb="$1" 'BEGIN { if (kb >= 1024) printf "%.1f MB", kb / 1024; else printf "%d KB", kb }'
}

# ----------------------------------------------------------------- cleanup ---

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cachenest-it.XXXXXX")

cleanup() {
  if [ "$KEEP" = "1" ]; then
    info "Keeping temp directory for inspection: $TMP_DIR"
  else
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- preflight --

step "Preflight"
for cmd in docker curl node npm; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is not available"

if [ "$(docker inspect -f '{{.State.Running}}' "$SERVICE" 2>/dev/null || true)" != "true" ]; then
  info "container '$SERVICE' is not running; starting it with docker compose up -d"
  "${COMPOSE[@]}" up -d || die "failed to start the $SERVICE service"
fi
pass "docker and container prerequisites are available"

# --------------------------------------------------------- 1. reachability ---

step "1. Health and reachability"
wait_for_health 60 || die "proxy did not become healthy at $BASE_URL/health"
HEALTH_JSON=$(curl -fsS --max-time 5 "$BASE_URL/health")
info "GET /health -> $HEALTH_JSON"
pass "/health responds"

curl -fsS --max-time 15 -o /dev/null "$BASE_URL/npm/" \
  || die "GET /npm/ failed"
pass "/npm/ responds"

curl -fsS --max-time 60 -o /dev/null "$BASE_URL/pypi/simple/" \
  || die "GET /pypi/simple/ failed"
pass "/pypi/simple/ responds"

# ------------------------------------------------------------ 2. cold miss ---

step "2. Cold install (cache miss)"

# A unique cache-busting query guarantees a cold key on every run without
# touching the existing cache or depending on a package never seen before.
RUN_ID=$(run_id)
TARBALL_PATH="/npm/$TARBALL_PKG/-/${TARBALL_PKG##*/}-$TARBALL_VERSION.tgz"
TEST_URL="$BASE_URL$TARBALL_PATH?cachenest_integration=$RUN_ID"
APP_DIR="$TMP_DIR/app"
mkdir -p "$APP_DIR"
( cd "$APP_DIR" && npm init -y >/dev/null 2>&1 ) || die "could not scaffold temp npm project"

read -r HITS0 MISSES0 SAVED0 <<<"$(snapshot)"
BLOBS0=$(count_blobs)
SIZE0=$(dir_size_kb)

info "installing ${TARBALL_PKG}@${TARBALL_VERSION} with a cold, throwaway npm cache"
info "$TEST_URL"
COLD_START=$(now_ms)
if ! (
  cd "$APP_DIR" \
    && NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false \
      npm install "$TEST_URL" \
        --registry "$BASE_URL/npm/" \
        --cache "$TMP_DIR/npm-cache-cold" \
        --no-audit --no-fund --loglevel=error
) >"$TMP_DIR/cold.log" 2>&1; then
  cat "$TMP_DIR/cold.log" >&2
  die "cold npm install failed"
fi
COLD_MS=$(( $(now_ms) - COLD_START ))

read -r HITS1 MISSES1 SAVED1 <<<"$(snapshot)"
BLOBS1=$(count_blobs)
SIZE1=$(dir_size_kb)

COLD_MISSES=$(( MISSES1 - MISSES0 ))
COLD_HITS=$(( HITS1 - HITS0 ))
COLD_BLOBS=$(( BLOBS1 - BLOBS0 ))
COLD_KB=$(( SIZE1 - SIZE0 ))

info "cold install completed in ${COLD_MS}ms"
info "cache misses +$COLD_MISSES, hits +$COLD_HITS, blobs +$COLD_BLOBS, disk +$(human_kb "$(( COLD_KB < 0 ? 0 : COLD_KB ))")"

[ "$COLD_MISSES" -ge 1 ] \
  || die "expected at least one cache miss during the cold install (got $COLD_MISSES)"
pass "cold install reached upstream ($COLD_MISSES cache miss(es))"

if [ "$COLD_BLOBS" -lt 1 ] && [ "$COLD_KB" -lt 1 ]; then
  die "no new blobs appeared in $DATA_DIR after the cold install"
fi
pass "cache wrote new data to $DATA_DIR (blobs +$COLD_BLOBS)"

INSTALLED=$(node -e "process.stdout.write(require('$APP_DIR/node_modules/$TARBALL_PKG/package.json').version)")
[ "$INSTALLED" = "$TARBALL_VERSION" ] \
  || die "installed version $INSTALLED does not match expected $TARBALL_VERSION"
pass "package installed and verified (${TARBALL_PKG}@$INSTALLED)"

# ------------------------------------------------------------ 3. warm hit ----

step "3. Warm install (cache hit)"

# Clear client-side artifacts only. The server-side ./data volume is untouched.
rm -rf "$APP_DIR/node_modules" "$APP_DIR/package-lock.json"

read -r HITS2 MISSES2 SAVED2 <<<"$(snapshot)"
BLOBS2=$(count_blobs)

info "reinstalling ${TARBALL_PKG}@${TARBALL_VERSION} with a fresh throwaway npm cache"
WARM_START=$(now_ms)
if ! (
  cd "$APP_DIR" \
    && NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false \
      npm install "$TEST_URL" \
        --registry "$BASE_URL/npm/" \
        --cache "$TMP_DIR/npm-cache-warm" \
        --no-audit --no-fund --loglevel=error
) >"$TMP_DIR/warm.log" 2>&1; then
  cat "$TMP_DIR/warm.log" >&2
  die "warm npm install failed"
fi
WARM_MS=$(( $(now_ms) - WARM_START ))

read -r HITS3 MISSES3 SAVED3 <<<"$(snapshot)"
BLOBS3=$(count_blobs)

WARM_MISSES=$(( MISSES3 - MISSES2 ))
WARM_HITS=$(( HITS3 - HITS2 ))
WARM_SAVED=$(( SAVED3 - SAVED2 ))
WARM_BLOBS=$(( BLOBS3 - BLOBS2 ))

info "warm install completed in ${WARM_MS}ms (cold was ${COLD_MS}ms)"
info "cache hits +$WARM_HITS, misses +$WARM_MISSES, bandwidth saved +$(human_kb "$(( WARM_SAVED / 1024 ))")"

[ "$WARM_MISSES" -eq 0 ] \
  || die "warm install made $WARM_MISSES upstream request(s); expected zero"
pass "warm install made zero upstream requests"

[ "$WARM_HITS" -ge 1 ] \
  || die "warm install recorded no cache hits; expected at least one"
pass "warm install was served from cache ($WARM_HITS hit(s))"

[ "$WARM_MS" -lt "$COLD_MS" ] \
  || die "warm install (${WARM_MS}ms) was not faster than cold (${COLD_MS}ms)"
pass "warm install was faster than cold (${WARM_MS}ms < ${COLD_MS}ms)"

[ "$WARM_BLOBS" -eq 0 ] \
  || die "warm install unexpectedly wrote $WARM_BLOBS new blob(s)"
pass "warm install wrote no new blobs (served from existing cache)"

# ------------------------------------------------------- 4. persistence -----

step "4. Volume persistence across container restart"

BLOBS_BEFORE_RESTART=$(count_blobs)
SIZE_BEFORE_RESTART=$(dir_size_kb)

info "restarting the '$SERVICE' service"
"${COMPOSE[@]}" restart "$SERVICE" >/dev/null || die "docker compose restart failed"
wait_for_health 60 || die "proxy did not become healthy after restart"
pass "container restarted and is healthy"

# Counters restart at zero, so a hit after restart proves the blob was reloaded
# from the host volume rather than kept in memory.
read -r HITS4 MISSES4 _ <<<"$(snapshot)"
FETCH=$(curl -sS --max-time 15 -o /dev/null \
  -w '%{http_code} %{time_total}' "$TEST_URL") \
  || die "post-restart fetch of the cached asset failed"
HTTP_CODE=${FETCH%% *}
FETCH_SECONDS=${FETCH##* }
read -r HITS5 MISSES5 _ <<<"$(snapshot)"
POST_HITS=$(( HITS5 - HITS4 ))
POST_MISSES=$(( MISSES5 - MISSES4 ))

info "GET cached asset after restart -> HTTP $HTTP_CODE in ${FETCH_SECONDS}s"
info "cache hits +$POST_HITS, misses +$POST_MISSES"

[ "$HTTP_CODE" = "200" ] || die "post-restart fetch returned HTTP $HTTP_CODE"
pass "previously cached asset is still served (HTTP 200)"

[ "$POST_HITS" -ge 1 ] || die "post-restart fetch was not a cache hit"
[ "$POST_MISSES" -eq 0 ] || die "post-restart fetch reached upstream; volume did not persist"
pass "asset was served from the persisted ./data volume, not upstream"

BLOBS_AFTER_RESTART=$(count_blobs)
[ "$BLOBS_AFTER_RESTART" = "$BLOBS_BEFORE_RESTART" ] \
  || die "blob count changed across restart ($BLOBS_BEFORE_RESTART -> $BLOBS_AFTER_RESTART)"
pass "cache contents unchanged across restart ($BLOBS_AFTER_RESTART blobs, $(human_kb "$SIZE_BEFORE_RESTART"))"

# -------------------------------------------------------------- summary -----

step "Summary"
cat <<EOF
    Test asset          ${TARBALL_PKG}@${TARBALL_VERSION}
    Cold install        ${COLD_MS}ms  misses +${COLD_MISSES}  blobs +${COLD_BLOBS}
    Warm install        ${WARM_MS}ms  hits +${WARM_HITS}  misses +${WARM_MISSES}
    Persistence         HTTP ${HTTP_CODE} after restart, hits +${POST_HITS}, misses +${POST_MISSES}
    Cache directory     ${DATA_DIR} ($(human_kb "$(dir_size_kb)"))
EOF

printf '\n%sALL INTEGRATION TESTS PASSED%s\n' "$C_GREEN" "$C_RESET"
