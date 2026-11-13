#!/bin/bash
# Starts SQL Server and, on first boot, attaches the vendor database files
# (mounted read-only at /seed) and creates the logins the stack uses.
set -euo pipefail

DATA=/var/opt/mssql/data
SQLCMD=(/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -b)

/opt/mssql/bin/sqlservr &
pid=$!

for _ in $(seq 1 60); do
  "${SQLCMD[@]}" -Q "SELECT 1" >/dev/null 2>&1 && break
  sleep 1
done

exists=$("${SQLCMD[@]}" -h -1 -W -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.databases WHERE name = N'$SCALE_DB_NAME'")
if [ "$exists" = "0" ]; then
  mdf=$(find /seed -maxdepth 1 -iname '*.mdf' | head -1)
  ldf=$(find /seed -maxdepth 1 -iname '*.ldf' | head -1)
  if [ -z "$mdf" ]; then
    echo "!! No .mdf in /seed (set SCALE_VENDOR_DIR in services/scale/.env)" >&2
  else
    echo ">> Attaching $(basename "$mdf") as [$SCALE_DB_NAME]"
    cp "$mdf" "$DATA/scale.mdf"
    attach="(FILENAME = N'$DATA/scale.mdf')"
    if [ -n "$ldf" ]; then
      cp "$ldf" "$DATA/scale_log.ldf"
      attach="$attach, (FILENAME = N'$DATA/scale_log.ldf')"
      mode="FOR ATTACH"
    else
      mode="FOR ATTACH_REBUILD_LOG"
    fi
    "${SQLCMD[@]}" -Q "CREATE DATABASE [$SCALE_DB_NAME] ON $attach $mode"
  fi
fi

# Logins are (re)applied on every start so password changes in .env take effect.
"${SQLCMD[@]}" -v DB="$SCALE_DB_NAME" API_PW="$SCALE_API_DB_PASSWORD" RO_PW="$INSPECTOR_DB_PASSWORD" -i /init/logins.sql \
  && echo ">> Scale database ready"

wait $pid
