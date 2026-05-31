#!/bin/bash
set -euo pipefail

SERVER_PORT="${GOLDPAN_SERVER_PORT:-3001}"
# Time (s) to wait for `bootstrap()` (migrations + optional embedding backfill +
# plugin init) to complete and the server to start listening before giving up.
# Default 120s covers cold-start with embedding backfill on a moderately sized
# DB. Must stay >= the Dockerfile HEALTHCHECK `start-period` so the container
# is not killed by the entrypoint before the orchestrator's grace window ends.
SERVER_READY_TIMEOUT="${GOLDPAN_SERVER_READY_TIMEOUT_S:-120}"
# Web off → server-only / IM-only deployment. Default true keeps the all-in-one
# behaviour. The /onboarding redirect in middleware.ts only triggers when web
# runs, so server-only deployments must be configured via CLI / .env / wizard
# CLI mirror (`pnpm onboard:cli`).
WEB_ENABLED="${GOLDPAN_WEB_ENABLED:-true}"
SERVER_PID=""
WEB_PID=""

# Flag the server runtime as docker-supervised so /onboarding/runtime-info
# advertises supervisor='docker' to the wizard UI — that's what drives the
# auto-restart polling vs. manual-restart UX in F8 RestartButton.
export SUPERVISED_BY_DOCKER=true

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && wait "$SERVER_PID" 2>/dev/null
  [ -n "$WEB_PID" ] && wait "$WEB_PID" 2>/dev/null
}
trap cleanup SIGTERM SIGINT

echo "Starting server on port ${SERVER_PORT}..."
node server/dist/main.js &
SERVER_PID=$!

echo "Waiting up to ${SERVER_READY_TIMEOUT}s for server to become healthy..."
SERVER_READY=false
for _ in $(seq 1 "$SERVER_READY_TIMEOUT"); do
  if node -e "fetch('http://localhost:${SERVER_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Server ready on port ${SERVER_PORT}."
    SERVER_READY=true
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server process exited unexpectedly" >&2
    exit 1
  fi
  sleep 1
done

if [ "$SERVER_READY" = false ]; then
  echo "Server failed to become healthy within ${SERVER_READY_TIMEOUT}s" >&2
  kill "$SERVER_PID" 2>/dev/null
  exit 1
fi

if [ "$WEB_ENABLED" = "true" ]; then
  echo "Starting web on port ${PORT:-3000}..."
  node apps/web/server.js &
  WEB_PID=$!

  # Wait for either process to exit — if one crashes, stop the other
  set +e
  wait -n "$SERVER_PID" "$WEB_PID"
  EXIT_CODE=$?
  kill "$SERVER_PID" "$WEB_PID" 2>/dev/null
  wait "$SERVER_PID" "$WEB_PID" 2>/dev/null
  exit $EXIT_CODE
else
  echo "Web disabled (GOLDPAN_WEB_ENABLED=${WEB_ENABLED}); waiting on server only..."
  set +e
  wait "$SERVER_PID"
  exit $?
fi
