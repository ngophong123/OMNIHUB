#!/bin/sh
set -eu
umask 077

mode="${1:-check}"
case "$mode" in check|verify|schedule) ;; *) echo 'UNSUPPORTED_DR_MONITOR_MODE' >&2; exit 2;; esac
state="${DR_MONITOR_STATE_DIR:-/monitor-state}"
max_age="${DR_MONITOR_MAX_AGE_SECONDS:-900}"
max_restore_age="${DR_MONITOR_RESTORE_MAX_AGE_SECONDS:-86400}"
interval="${DR_MONITOR_INTERVAL_SECONDS:-60}"
for value in "$max_age" "$max_restore_age" "$interval"; do
  case "$value" in ''|*[!0-9]*) echo 'INVALID_MONITOR_THRESHOLD' >&2; exit 2;; esac
  test "$value" -gt 0 || { echo 'INVALID_MONITOR_THRESHOLD' >&2; exit 2; }
done
test "$interval" -ge 10 && test "$interval" -le 3600 || { echo 'INVALID_MONITOR_INTERVAL' >&2; exit 2; }
test "$max_restore_age" -gt "$interval" || { echo 'INVALID_RESTORE_VERIFICATION_INTERVAL' >&2; exit 2; }
mkdir -p "$state"
if test "$mode" = schedule; then
  trap 'exit 0' TERM INT
  while :; do
    current="$(date +%s)"
    last=0
    if test -s "$state/restore-verified.json"; then
      last="$(jq -er '.verifiedUnix | numbers' "$state/restore-verified.json" 2>/dev/null)" || last=0
    fi
    if test "$((current - last))" -ge "$((max_restore_age - interval))"; then
      "$0" verify || true
    fi
    "$0" check || true
    sleep "$interval" & wait $! || true
  done
fi
now="$(date +%s)"
if test "${DR_MONITOR_TEST_MODE:-}" = true; then
  test "${DR_MONITOR_NOW_UNIX:-}" = '' || now="${DR_MONITOR_NOW_UNIX}"
  case "$now" in ''|*[!0-9]*) echo 'INVALID_MONITOR_CLOCK' >&2; exit 2;; esac
fi
now_utc() { date -u -d "@$now" +%FT%TZ; }
write_atomic() {
  target="$1"
  temporary="$(mktemp "$state/.monitor.XXXXXX")" || return 1
  if ! cat > "$temporary"; then rm -f "$temporary"; return 1; fi
  mv -f "$temporary" "$target"
}
notify() {
  code="$1"
  age_field=''
  if test -n "${2:-}"; then
    case "$2" in *[!0-9]*|'') echo 'INVALID_EVENT_AGE' >&2; return 1;; esac
    age_field=",\"ageSeconds\":$2"
  fi
  event="$(printf '{"at":"%s","code":"%s","level":"critical"%s}' "$(now_utc)" "$code" "$age_field")"
  printf '%s\n' "$event" >&2
  printf '%s\n' "$event" >> "$state/events.jsonl"
  endpoint_file="${DR_ALERT_WEBHOOK_URL_FILE:-}"
  approved_file="${DR_ALERT_APPROVED_URL_FILE:-}"
  if test -z "$endpoint_file" && test -z "$approved_file"; then return 0; fi
  if test -z "$endpoint_file" || test -z "$approved_file"; then echo 'ALERT_DESTINATION_INCOMPLETE' >&2; return 1; fi
  if ! test -r "$endpoint_file" || ! test -r "$approved_file"; then echo 'ALERT_DESTINATION_FILE_UNREADABLE' >&2; return 1; fi
  endpoint="$(cat "$endpoint_file")"
  if test "$endpoint" != "$(cat "$approved_file")"; then echo 'ALERT_DESTINATION_NOT_APPROVED' >&2; return 1; fi
  case "$endpoint" in https://*) ;; *) echo 'ALERT_HTTPS_REQUIRED' >&2; return 1;; esac
  case "$endpoint" in *[!a-zA-Z0-9._~:/%+-]*) echo 'ALERT_DESTINATION_REJECTED' >&2; return 1;; esac
  config="$(mktemp /tmp/omnihub-alert.XXXXXX)" || return 1
  printf 'url = "%s"\nrequest = "POST"\nheader = "Content-Type: application/json"\n' "$endpoint" > "$config"
  if test -n "${DR_ALERT_BEARER_FILE:-}"; then
    test -r "$DR_ALERT_BEARER_FILE" || { rm -f -- "$config"; echo 'ALERT_BEARER_FILE_UNREADABLE' >&2; return 1; }
    bearer="$(cat "$DR_ALERT_BEARER_FILE")"
    case "$bearer" in ''|*[!a-zA-Z0-9._~-]*) rm -f -- "$config"; echo 'ALERT_BEARER_INVALID' >&2; return 1;; esac
    printf 'header = "Authorization: Bearer %s"\n' "$bearer" >> "$config"
  fi
  if ! printf '%s' "$event" | curl --config "$config" --proto '=https' --tlsv1.2 --fail --silent --show-error --max-time 10 --data-binary @- > /dev/null; then
    rm -f -- "$config"
    echo 'ALERT_DELIVERY_FAILED' >&2
    return 1
  fi
  rm -f -- "$config"
  printf '{"code":"%s","deliveredUnix":%s}\n' "$code" "$now" | write_atomic "$state/last-delivery.json" || { echo 'ALERT_DELIVERY_STATE_FAILED' >&2; return 1; }
}
fail() { notify "$@" || true; return 1; }

repository="${DR_MONITOR_REPOSITORY:-}"
password_file="${DR_MONITOR_PASSWORD_FILE:-}"
test -n "$repository" && test -n "$password_file" && test -r "$password_file" || { fail REMOTE_REPOSITORY_NOT_CONFIGURED; exit 1; }
if test "${DR_MONITOR_TEST_MODE:-}" = true; then
  test "$repository" = /fixture/remote && test "$state" = /fixture/monitor || { fail INVALID_DISPOSABLE_TEST_CONFIGURATION; exit 1; }
else
  test "${DR_MONITOR_APPROVED:-}" = true || { fail REMOTE_REPOSITORY_NOT_APPROVED; exit 1; }
  case "$repository" in rest:https://*) ;; *) fail REMOTE_HTTPS_REPOSITORY_REQUIRED; exit 1;; esac
  case "$repository" in *localhost*|*127.0.0.1*|*'@'*) fail REMOTE_SEPARATE_HOST_REQUIRED; exit 1;; esac
  allow_file="${DR_MONITOR_APPROVED_REPOSITORY_FILE:-}"
  test -n "$allow_file" && test -r "$allow_file" && test "$repository" = "$(cat "$allow_file")" || { fail REMOTE_REPOSITORY_NOT_APPROVED; exit 1; }
fi

if test "$mode" = check; then
  primary_failed=0
  primary_file="${DR_PRIMARY_HEALTH_URL_FILE:-}"
  if test -z "$primary_file" || ! test -r "$primary_file"; then
    fail PRIMARY_HEALTH_NOT_CONFIGURED || primary_failed=1
  else
    primary="$(cat "$primary_file")"
    if test "${DR_MONITOR_TEST_MODE:-}" != true; then
      primary_allow="${DR_PRIMARY_APPROVED_URL_FILE:-}"
      test -n "$primary_allow" && test -r "$primary_allow" && test "$primary" = "$(cat "$primary_allow")" || { fail PRIMARY_HEALTH_NOT_APPROVED; exit 1; }
      case "$primary" in https://*) ;; *) fail PRIMARY_HTTPS_REQUIRED; exit 1;; esac
    fi
    protocols='=https,http'
    if test "${DR_MONITOR_TEST_MODE:-}" = true; then protocols='=https,http,file'; fi
    if ! curl --proto "$protocols" --fail --silent --show-error --max-time 5 "$primary" > /dev/null; then fail PRIMARY_UNREACHABLE || primary_failed=1; fi
  fi
fi

if ! restic --no-lock -r "$repository" --password-file "$password_file" check --quiet; then fail REMOTE_REPOSITORY_INVALID; exit 1; fi
scratch="$(mktemp -d /tmp/omnihub-dr-monitor.XXXXXX)" || { fail MONITOR_SCRATCH_FAILED; exit 1; }
trap 'rm -rf -- "$scratch"' EXIT
if ! restic --no-lock -r "$repository" --password-file "$password_file" snapshots --json --host omnihub-staging --tag postgres > "$scratch/snapshots.json"; then fail REMOTE_SNAPSHOT_LIST_FAILED; exit 1; fi
snapshot="$(jq -er 'sort_by(.time) | last | .id' "$scratch/snapshots.json")" || { fail REMOTE_BACKUP_MISSING; exit 1; }
if ! restic --no-lock -r "$repository" --password-file "$password_file" dump "$snapshot" /backup-manifest.json > "$scratch/manifest.json"; then fail REMOTE_MANIFEST_MISSING; exit 1; fi
point="$(jq -er 'select(.formatVersion == 1) | .recoveryPointUnix | numbers' "$scratch/manifest.json")" || { fail REMOTE_MANIFEST_INVALID; exit 1; }
case "$point" in ''|*[!0-9]*) fail REMOTE_MANIFEST_INVALID; exit 1;; esac
age="$((now - point))"
if test "$age" -lt 0; then fail REMOTE_RECOVERY_POINT_IN_FUTURE; exit 1; fi
if test "$age" -ge "$max_age"; then fail REMOTE_BACKUP_STALE "$age"; exit 1; fi

if ! restic --no-lock -r "$repository" --password-file "$password_file" restore "$snapshot" --target "$scratch/recovered" > /dev/null; then fail REMOTE_RESTORE_FAILED; exit 1; fi
if ! (cd "$scratch/recovered" && sha256sum -c database.dump.sha256 > /dev/null); then fail REMOTE_CHECKSUM_FAILED; exit 1; fi
if ! pg_restore --list "$scratch/recovered/database.dump" > /dev/null; then fail REMOTE_ARCHIVE_INVALID; exit 1; fi
if ! jq -e --argjson point "$point" --argjson size "$(wc -c < "$scratch/recovered/database.dump")" '.formatVersion == 1 and .recoveryPointUnix == $point and .dumpBytes == $size' "$scratch/recovered/backup-manifest.json" > /dev/null; then fail REMOTE_MANIFEST_MISMATCH; exit 1; fi

if test "$mode" = verify; then
  printf '{"verifiedUnix":%s,"snapshotId":"%s","recoveryPointUnix":%s}\n' "$now" "$snapshot" "$point" | write_atomic "$state/restore-verified.json" || { fail RESTORE_VERIFICATION_STATE_FAILED; exit 1; }
  printf '{"status":"REMOTE_RESTORE_VERIFIED","snapshotId":"%s","recoveryPointAgeSeconds":%s}\n' "$snapshot" "$age"
else
  if ! test -s "$state/restore-verified.json"; then fail RESTORE_VERIFICATION_MISSING; exit 1; fi
  restore_time="$(jq -er '.verifiedUnix | numbers' "$state/restore-verified.json")" || { fail RESTORE_VERIFICATION_INVALID; exit 1; }
  restore_age="$((now - restore_time))"
  if test "$restore_age" -lt 0 || test "$restore_age" -ge "$max_restore_age"; then fail RESTORE_VERIFICATION_STALE; exit 1; fi
  test "$primary_failed" -eq 0 || exit 1
  printf '{"status":"REMOTE_BACKUP_HEALTHY","snapshotId":"%s","recoveryPointAgeSeconds":%s,"restoreVerificationAgeSeconds":%s}\n' "$snapshot" "$age" "$restore_age"
fi
