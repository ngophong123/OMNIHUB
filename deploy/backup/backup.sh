#!/bin/sh
set -eu
umask 077

mode="${1:-schedule}"
state="${BACKUP_STATE_DIR:-/state}"
password_file="${BACKUP_DB_PASSWORD_FILE:-/run/secrets/db_backup_password}"
interval="${BACKUP_INTERVAL_SECONDS:-300}"
max_age="${BACKUP_MAX_AGE_SECONDS:-900}"
monitor_interval="${BACKUP_MONITOR_INTERVAL_SECONDS:-30}"
alert_repeat="${BACKUP_ALERT_REPEAT_SECONDS:-300}"
for value in "$interval" "$max_age" "$monitor_interval" "$alert_repeat"; do
  case "$value" in ''|*[!0-9]*) echo 'INVALID_BACKUP_INTERVAL' >&2; exit 2;; esac
  test "$value" -gt 0 || { echo 'INVALID_BACKUP_INTERVAL' >&2; exit 2; }
done
test "$interval" -ge 10 && test "$interval" -le 86400
test "$max_age" -ge "$interval"
mkdir -p "$state"

now_utc() { date -u +%FT%TZ; }
write_atomic() {
  target="$1"
  temporary="$(mktemp "$state/.status.XXXXXX")" || return 1
  if ! cat > "$temporary"; then rm -f "$temporary"; return 1; fi
  mv -f "$temporary" "$target"
}
alert() {
  code="$1"
  age="${2:-0}"
  line="$(printf '{"level":"error","code":"%s","at":"%s","ageSeconds":%s}' "$code" "$(now_utc)" "$age")"
  printf '%s\n' "$line" >&2
  printf '%s\n' "$line" >> "$state/alerts.jsonl" || true
  if ! printf '%s\n' "$line" | /usr/local/bin/omnihub-alert-webhook; then
    printf '%s\n' '{"level":"error","code":"ALERT_DELIVERY_FAILED"}' >&2
  fi
}
record_failure() {
  reason="$1"
  started="$2"
  ended="$(date +%s)"
  duration="$((ended - started))"
  printf '{"at":"%s","status":"FAILED","reason":"%s","durationSeconds":%s}\n' "$(now_utc)" "$reason" "$duration" | write_atomic "$state/last-attempt.json" || alert BACKUP_STATE_WRITE_FAILED
  alert "$reason"
  return 1
}
verified_age() {
  test -s "$state/verified.json" || return 1
  point="$(jq -er '.recoveryPointUnix | numbers' "$state/verified.json")" || return 1
  case "$point" in ''|*[!0-9]*) return 1;; esac
  age="$(( $(date +%s) - point ))"
  test "$age" -ge 0 || return 1
  printf '%s\n' "$age"
}
backup_once() (
  started="$(date +%s)"
  exec 9> "$state/backup.lock" || { record_failure BACKUP_LOCK_OPEN_FAILED "$started"; return 1; }
  if ! flock -n 9; then alert BACKUP_OVERLAP; return 75; fi
  if ! scratch="$(mktemp -d /tmp/omnihub-backup.XXXXXX)"; then record_failure BACKUP_SCRATCH_FAILED "$started"; return 1; fi
  trap 'rm -rf -- "$scratch"' EXIT
  if ! PGPASSWORD="$(cat "$password_file")"; then record_failure BACKUP_SECRET_UNAVAILABLE "$started"; return 1; fi
  export PGPASSWORD PGCONNECT_TIMEOUT=10
  if ! pg_dump --format=custom --no-owner --no-acl --file="$scratch/database.dump"; then record_failure PG_DUMP_FAILED "$started"; return 1; fi
  bytes="$(wc -c < "$scratch/database.dump")" || { record_failure BACKUP_TRUNCATED "$started"; return 1; }
  if test "$bytes" -lt 1024; then record_failure BACKUP_TRUNCATED "$started"; return 1; fi
  if ! pg_restore --list "$scratch/database.dump" > "$scratch/archive.list"; then record_failure BACKUP_ARCHIVE_INVALID "$started"; return 1; fi
  if ! grep -q '_prisma_migrations' "$scratch/archive.list"; then record_failure BACKUP_SCHEMA_MISSING "$started"; return 1; fi
  if ! (cd "$scratch" && sha256sum database.dump > database.dump.sha256); then record_failure BACKUP_CHECKSUM_FAILED "$started"; return 1; fi
  if ! printf '{"formatVersion":1,"recoveryPointUnix":%s,"dumpBytes":%s}\n' "$started" "$bytes" > "$scratch/backup-manifest.json"; then record_failure BACKUP_MANIFEST_FAILED "$started"; return 1; fi
  if ! (cd "$scratch" && restic backup --json --host omnihub-staging --tag postgres database.dump database.dump.sha256 backup-manifest.json > backup-result.json); then record_failure RESTIC_BACKUP_FAILED "$started"; return 1; fi
  snapshot="$(jq -r 'select(.message_type == "summary") | .snapshot_id' "$scratch/backup-result.json" | tail -n 1)" || snapshot=''
  case "$snapshot" in *[!a-f0-9]*|'') record_failure RESTIC_SNAPSHOT_ID_INVALID "$started"; return 1;; esac
  if test "${#snapshot}" -ne 64; then record_failure RESTIC_SNAPSHOT_ID_INVALID "$started"; return 1; fi
  if ! restic check --quiet; then record_failure RESTIC_REPOSITORY_INVALID "$started"; return 1; fi
  if ! restic restore "$snapshot" --target "$scratch/recovered" > /dev/null; then record_failure RESTIC_DECRYPT_FAILED "$started"; return 1; fi
  if ! (cd "$scratch/recovered" && sha256sum -c database.dump.sha256 > /dev/null); then record_failure RESTIC_CONTENT_MISMATCH "$started"; return 1; fi
  if ! pg_restore --list "$scratch/recovered/database.dump" > /dev/null; then record_failure RESTIC_ARCHIVE_INVALID "$started"; return 1; fi
  if ! jq -e --argjson point "$started" --argjson size "$bytes" '.formatVersion == 1 and .recoveryPointUnix == $point and .dumpBytes == $size' "$scratch/recovered/backup-manifest.json" > /dev/null; then record_failure RESTIC_MANIFEST_INVALID "$started"; return 1; fi
  ended="$(date +%s)"
  duration="$((ended - started))"
  if ! printf '{"recoveryPointAt":"%s","recoveryPointUnix":%s,"verifiedAt":"%s","verifiedUnix":%s,"snapshotId":"%s","dumpBytes":%s,"durationSeconds":%s}\n' "$(date -u -d "@$started" +%FT%TZ)" "$started" "$(now_utc)" "$ended" "$snapshot" "$bytes" "$duration" | write_atomic "$state/verified.json"; then
    record_failure BACKUP_STATE_WRITE_FAILED "$started"; return 1
  fi
  if ! printf '{"at":"%s","status":"VERIFIED","snapshotId":"%s","durationSeconds":%s}\n' "$(now_utc)" "$snapshot" "$duration" | write_atomic "$state/last-attempt.json"; then
    alert BACKUP_ATTEMPT_STATE_WRITE_FAILED
  fi
  printf '{"level":"info","code":"ENCRYPTED_BACKUP_VERIFIED","snapshotId":"%s","recoveryPointUnix":%s,"durationSeconds":%s,"dumpBytes":%s}\n' "$snapshot" "$started" "$duration" "$bytes"
)
monitor() {
  while :; do
    current="$(date +%s)"
    age="$(verified_age 2>/dev/null)" || age="$((max_age + 1))"
    if test "$age" -ge "$max_age"; then
      previous=0
      test ! -s "$state/last-stale-alert" || previous="$(cat "$state/last-stale-alert")"
      case "$previous" in ''|*[!0-9]*) previous=0;; esac
      if test "$((current - previous))" -ge "$alert_repeat"; then
        alert BACKUP_STALE "$age"
        printf '%s\n' "$current" | write_atomic "$state/last-stale-alert" || alert BACKUP_STATE_WRITE_FAILED
      fi
    fi
    sleep "$monitor_interval" & wait $! || true
  done
}
case "$mode" in
  init) exec restic init ;;
  once) backup_once ;;
  health)
    age="$(verified_age)" || exit 1
    test "$age" -lt "$max_age"
    ;;
  monitor) monitor ;;
  retention-plan)
    exec restic forget --host omnihub-staging --tag postgres --group-by host,tags --keep-last 4 --keep-hourly 48 --keep-daily 30 --keep-weekly 12 --keep-monthly 12 --dry-run ;;
  schedule)
    trap 'exit 0' TERM INT
    while :; do
      slot="$(date +%s)"
      backup_once || true
      elapsed="$(( $(date +%s) - slot ))"
      delay="$((interval - elapsed))"
      test "$delay" -gt 0 || delay=1
      sleep "$delay" & wait $! || true
    done ;;
  *) echo 'UNSUPPORTED_BACKUP_MODE' >&2; exit 2 ;;
esac
