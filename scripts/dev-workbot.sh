#!/usr/bin/env bash
# Workbot on this machine: Den (API + web on the local MySQL/Redis) and the
# headless runner, wired together, both reloading on save.
#
#   pnpm dev:den:mysql        # once, starts MySQL and Redis in Docker
#   pnpm dev:workbot          # then open http://localhost:3005/workbot
#
# The runner talks to Anthropic directly. It uses HEADLESS_MODEL_API_KEY when
# set, otherwise ANTHROPIC_API_KEY, otherwise the team's dev key from Infisical.
# Override the model with HEADLESS_MODEL (default claude-sonnet-5-5).
# Files are kept on disk in .data/workbot-files; set HEADLESS_FILES=s3 and the
# HEADLESS_S3_* variables to use a bucket instead, or HEADLESS_FILES=off.
# Each conversation gets a Linux computer (a Freestyle VM) when FREESTYLE_API_KEY
# is set or Infisical has it (dev, /openwork-ops); HEADLESS_COMPUTER=off turns it off.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNNER_PORT="${HEADLESS_PORT:-8795}"
API_PORT="${DEN_API_PORT:-8788}"
# Local-only service token between Den and the runner; not a secret.
RUNNER_TOKEN="local-workbot-runner-token-not-a-secret-0000"

key="${HEADLESS_MODEL_API_KEY:-${ANTHROPIC_API_KEY:-}}"
if [ -z "$key" ] && command -v infisical >/dev/null; then
  key="$(infisical secrets get ANTHROPIC_API_KEY --env dev --plain --silent 2>/dev/null || true)"
  [ "$key" = "*not found*" ] && key=""
fi
if [ -z "$key" ]; then
  echo "dev-workbot: set ANTHROPIC_API_KEY (or log in to Infisical) so the runner can reach a model." >&2
  exit 1
fi

computer="${HEADLESS_COMPUTER:-}"
freestyle="${FREESTYLE_API_KEY:-}"
if [ "$computer" != "off" ] && [ -z "$freestyle" ] && command -v infisical >/dev/null; then
  freestyle="$(infisical secrets get FREESTYLE_API_KEY --env dev --path /openwork-ops --plain --silent 2>/dev/null || true)"
  [ "$freestyle" = "*not found*" ] && freestyle=""
fi
if [ -z "$computer" ]; then
  if [ -n "$freestyle" ]; then computer=freestyle; else computer=off; fi
fi
if [ "$computer" = "freestyle" ]; then
  # A no-op unless computer-image.ts changed; then it builds the new snapshot (about three minutes).
  FREESTYLE_API_KEY="$freestyle" pnpm --filter @openwork-ee/headless-computer snapshot:build
fi

mkdir -p .data
HEADLESS_COMPUTER="$computer" \
FREESTYLE_API_KEY="$freestyle" \
HEADLESS_API_TOKEN="$RUNNER_TOKEN" \
HEADLESS_PORT="$RUNNER_PORT" \
HEADLESS_DB_PATH="${HEADLESS_DB_PATH:-$PWD/.data/workbot-runner.sqlite}" \
HEADLESS_MODEL_PROTOCOL="${HEADLESS_MODEL_PROTOCOL:-anthropic}" \
HEADLESS_MODEL_BASE_URL="${HEADLESS_MODEL_BASE_URL:-https://api.anthropic.com/v1}" \
HEADLESS_MODEL="${HEADLESS_MODEL:-claude-sonnet-5-5}" \
HEADLESS_MODEL_API_KEY="$key" \
HEADLESS_MCP_URL="http://127.0.0.1:${API_PORT}/mcp/agent" \
HEADLESS_FILES="${HEADLESS_FILES:-disk}" \
HEADLESS_FILES_DIR="${HEADLESS_FILES_DIR:-$PWD/.data/workbot-files}" \
  pnpm --filter @openwork-ee/headless-runner dev &
runner=$!
trap 'kill $runner 2>/dev/null || true' EXIT INT TERM

DEN_HEADLESS_RUNNER_URL="http://127.0.0.1:${RUNNER_PORT}" \
DEN_HEADLESS_RUNNER_TOKEN="$RUNNER_TOKEN" \
  pnpm dev:den
