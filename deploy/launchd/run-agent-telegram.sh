#!/bin/sh
set -eu

umask 077

ENV_FILE="${AGENT_TELEGRAM_ENV_FILE:-$HOME/.config/agent-telegram/copilot.env}"
if [ -L "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "agent-telegram: environment file must be a regular non-symlink file: $ENV_FILE" >&2
  exit 1
fi

MODE=$(/usr/bin/stat -f '%Lp' "$ENV_FILE")
case "$MODE" in
  400|600) ;;
  *)
    echo "agent-telegram: environment file must have mode 0400 or 0600 (found $MODE)" >&2
    exit 1
    ;;
esac

set -a
# This owner-only file is trusted configuration and must contain shell-compatible KEY=value entries.
. "$ENV_FILE"
set +a

: "${NODE_BIN:?NODE_BIN is required in $ENV_FILE}"
: "${AGENT_TELEGRAM_REPO:?AGENT_TELEGRAM_REPO is required in $ENV_FILE}"

exec "$NODE_BIN" "$AGENT_TELEGRAM_REPO/dist/src/index.js"
