#!/usr/bin/env bash
#
# Register the Tereflow pipeline on a Linux or macOS box.
#
# Runs every Friday at 21:00 UTC. Adding it to root's crontab is avoided on
# purpose; this installs into the current user's crontab.
#
#   bash local/schedule-unix.sh
#
# To remove it:
#   crontab -l | grep -v tereflow-pipeline | crontab -

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/local/dist/pipeline.mjs"

if [ ! -f "$SCRIPT" ]; then
  echo "Pipeline is not built yet. Run:"
  echo "    cd $REPO && npm run pipeline:build"
  exit 1
fi

if [ ! -f "$REPO/local/.env" ]; then
  echo "local/.env is missing. Copy local/.env.example and fill it in."
  exit 1
fi

NODE="$(command -v node)"
mkdir -p "$REPO/local/logs"

# CRON_TZ makes the schedule mean 21:00 UTC regardless of the server's zone,
# which is the whole point: publication time should not move with the host.
LINE="CRON_TZ=UTC 0 21 * * 5 cd $REPO && $NODE local/dist/pipeline.mjs >> local/logs/pipeline-\$(date +\\%Y\\%m\\%d).log 2>&1 # tereflow-pipeline"

( crontab -l 2>/dev/null | grep -v 'tereflow-pipeline' || true; echo "$LINE" ) | crontab -

echo "Installed. Friday 21:00 UTC."
echo "  logs  $REPO/local/logs"
echo ""
echo "Verify with: crontab -l | grep tereflow"
echo "Test now:    cd $REPO && node local/dist/pipeline.mjs --slug ghana"
