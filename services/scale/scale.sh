#!/bin/sh
# Wrapper around docker compose for the Scale Service stack.
#   npm run scale up | down | logs | ps | build | reset
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created services/scale/.env from the example. Set SCALE_VENDOR_DIR and the passwords, then re-run." >&2
  exit 1
fi
if [ ! -f config/Integration.dll.config ]; then
  cp config/Integration.dll.config.example config/Integration.dll.config
  echo "Created services/scale/config/Integration.dll.config with empty credentials (GPS/SAP calls will fail until filled in)."
fi

dc() { docker compose --env-file .env -f compose.yaml "$@"; }

case "${1:-up}" in
  up)    dc up -d --build && echo "Scale API: http://localhost:5080  Inspector: http://localhost:5081/api/status" ;;
  down)  dc down ;;
  logs)  shift; dc logs -f "$@" ;;
  ps)    dc ps ;;
  build) dc build ;;
  reset) dc down -v ;;  # drops the database volume; next `up` re-attaches the vendor .mdf
  *)     dc "$@" ;;
esac
