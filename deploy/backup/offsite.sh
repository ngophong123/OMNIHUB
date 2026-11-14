#!/bin/sh
set -eu
umask 077

mode="${1:-verify}"
case "$mode" in copy|verify|schedule) ;; *) echo 'UNSUPPORTED_OFFSITE_MODE' >&2; exit 2;; esac
state="${BACKUP_STATE_DIR:-/state}"
interval="${OFFSITE_INTERVAL_SECONDS:-300}"
max_age="${OFFSITE_MAX_AGE_SECONDS:-900}"
case "$interval" in ''|*[!0-9]*) echo 'INVALID_OFFSITE_INTERVAL' >&2; exit 2;; esac
test "$interval" -ge 60 && test "$interval" -le 86400 || { echo 'INVALID_OFFSITE_INTERVAL' >&2; exit 2; }
case "$max_age" in ''|*[!0-9]*) echo 'INVALID_OFFSITE_MAX_AGE' >&2; exit 2;; esac
test "$max_age" -ge "$interval" || { echo 'INVALID_OFFSITE_MAX_AGE' >&2; exit 2; }
remote="${OFFSITE_REPOSITORY:-}"
approved_file="${OFFSITE_APPROVED_REPOSITORY_FILE:-}"
password_file="${OFFSITE_PASSWORD_FILE:-}"
if test "${OFFSITE_TEST_MODE:-}" = true; then
  test "$state" = /fixture/state && test "$remote" = /fixture/remote && test "$approved_file" = /fixture/approved && test "$password_file" = /fixture/test-password || { echo 'INVALID_DISPOSABLE_TEST_CONFIGURATION' >&2; exit 2; }
else
  test "${OFFSITE_APPROVED:-}" = 'true' || { echo 'OFFSITE_NOT_APPROVED' >&2; exit 2; }
  case "$remote" in rest:https://*) ;; *) echo 'OFFSITE_HTTPS_REPOSITORY_REQUIRED' >&2; exit 2;; esac
  case "$remote" in *localhost*|*127.0.0.1*|*'@'*) echo 'OFFSITE_SEPARATE_HOST_REQUIRED' >&2; exit 2;; esac
fi
test -n "$approved_file" && test -r "$approved_file" || { echo 'OFFSITE_APPROVED_REPOSITORY_FILE_REQUIRED' >&2; exit 2; }
test "$remote" = "$(cat "$approved_file")" || { echo 'OFFSITE_DESTINATION_NOT_ALLOWLISTED' >&2; exit 2; }
test -n "$password_file" && test -r "$password_file" || { echo 'OFFSITE_PASSWORD_FILE_REQUIRED' >&2; exit 2; }
mkdir -p "$state"

now_utc() { date -u +%FT%TZ; }
write_atomic() {
  target="$1"
  temporary="$(mktemp "$state/.offsite.XXXXXX")" || return 1
  if ! cat > "$temporary"; then rm -f "$temporary"; return 1; fi
  mv -f "$temporary" "$target"
}
fail() {
  reason="$1"
  started="$2"
  duration="$(( $(date +%s) - started ))"
  printf '{"at":"%s","status":"FAILED","reason":"%s","durationSeconds":%s}\n' "$(now_utc)" "$reason" "$duration" | write_atomic "$state/offsite-last-attempt.json" || true
  event="$(printf '{"level":"error","code":"%s","at":"%s","durationSeconds":%s}' "$reason" "$(now_utc)" "$duration")"
  printf '%s\n' "$event" | tee -a "$state/alerts.jsonl" >&2
  printf '%s\n' "$event" | /usr/local/bin/omnihub-alert-webhook || echo 'ALERT_DELIVERY_FAILED' >&2
  return 1
}
offsite_once() (
  started="$(date +%s)"
  exec 9> "$state/offsite.lock" || { fail OFFSITE_LOCK_FAILED "$started"; return 1; }
  if ! flock -n 9; then fail OFFSITE_OVERLAP "$started"; return 75; fi
  test -s "$state/verified.json" || { fail LOCAL_VERIFIED_BACKUP_REQUIRED "$started"; return 1; }
  snapshot="$(jq -er '.snapshotId' "$state/verified.json")" || { fail LOCAL_VERIFIED_STATE_INVALID "$started"; return 1; }
  point="$(jq -er '.recoveryPointUnix | numbers' "$state/verified.json")" || { fail LOCAL_VERIFIED_STATE_INVALID "$started"; return 1; }
  case "$point" in ''|*[!0-9]*) fail LOCAL_VERIFIED_STATE_INVALID "$started"; return 1;; esac
  age_now="$started"
  if test "${OFFSITE_TEST_MODE:-}" = true && test -n "${OFFSITE_TEST_NOW_UNIX:-}"; then
    age_now="$OFFSITE_TEST_NOW_UNIX"
    case "$age_now" in ''|*[!0-9]*) fail INVALID_DISPOSABLE_TEST_CLOCK "$started"; return 1;; esac
  fi
  age="$((age_now - point))"
  if test "$age" -lt 0 || test "$age" -ge "$max_age"; then fail LOCAL_VERIFIED_BACKUP_STALE "$started"; return 1; fi
  case "$snapshot" in ''|*[!a-f0-9]*) fail INVALID_LOCAL_SNAPSHOT_ID "$started"; return 1;; esac
  test "${#snapshot}" -eq 64 || { fail INVALID_LOCAL_SNAPSHOT_ID "$started"; return 1; }
  scratch="$(mktemp -d /tmp/omnihub-offsite.XXXXXX)" || { fail OFFSITE_SCRATCH_FAILED "$started"; return 1; }
  trap 'rm -rf -- "$scratch"' EXIT

  if ! restic restore "$snapshot" --target "$scratch/source" > /dev/null; then fail LOCAL_SNAPSHOT_UNREADABLE "$started"; return 1; fi
  if ! (cd "$scratch/source" && sha256sum -c database.dump.sha256 > /dev/null); then fail LOCAL_SNAPSHOT_CHECKSUM_FAILED "$started"; return 1; fi
  if ! pg_restore --list "$scratch/source/database.dump" > /dev/null; then fail LOCAL_ARCHIVE_INVALID "$started"; return 1; fi
  source_bytes="$(wc -c < "$scratch/source/database.dump")"
  if ! jq -e --argjson point "$point" --argjson size "$source_bytes" '.formatVersion == 1 and .recoveryPointUnix == $point and .dumpBytes == $size' "$scratch/source/backup-manifest.json" > /dev/null; then fail LOCAL_MANIFEST_INVALID "$started"; return 1; fi
  source_hash="$(sha256sum "$scratch/source/database.dump" | cut -d ' ' -f 1)"

  if test "$mode" = copy; then
    # The approved remote repository is initialized and owned by the operator.
    if ! restic copy --repo2 "$remote" --password-file2 "$password_file" "$snapshot" > /dev/null; then fail OFFSITE_COPY_FAILED "$started"; return 1; fi
  fi
  if ! restic -r "$remote" --password-file "$password_file" check --quiet; then fail OFFSITE_REPOSITORY_INVALID "$started"; return 1; fi
  if ! restic -r "$remote" --password-file "$password_file" snapshots --json --host omnihub-staging --tag postgres > "$scratch/remote-snapshots.json"; then fail OFFSITE_SNAPSHOT_LIST_FAILED "$started"; return 1; fi
  remote_snapshot="$(jq -er 'sort_by(.time) | last | .id' "$scratch/remote-snapshots.json")" || { fail OFFSITE_SNAPSHOT_MISSING "$started"; return 1; }
  case "$remote_snapshot" in ''|*[!a-f0-9]*) fail OFFSITE_SNAPSHOT_MISSING "$started"; return 1;; esac
  if ! restic -r "$remote" --password-file "$password_file" restore "$remote_snapshot" --target "$scratch/remote" > /dev/null; then fail OFFSITE_DECRYPT_FAILED "$started"; return 1; fi
  if ! (cd "$scratch/remote" && sha256sum -c database.dump.sha256 > /dev/null); then fail OFFSITE_CHECKSUM_FAILED "$started"; return 1; fi
  if ! pg_restore --list "$scratch/remote/database.dump" > /dev/null; then fail OFFSITE_ARCHIVE_INVALID "$started"; return 1; fi
  remote_bytes="$(wc -c < "$scratch/remote/database.dump")"
  if ! jq -e --argjson point "$point" --argjson size "$remote_bytes" '.formatVersion == 1 and .recoveryPointUnix == $point and .dumpBytes == $size' "$scratch/remote/backup-manifest.json" > /dev/null; then fail OFFSITE_MANIFEST_MISMATCH "$started"; return 1; fi
  remote_hash="$(sha256sum "$scratch/remote/database.dump" | cut -d ' ' -f 1)"
  test "$source_hash" = "$remote_hash" || { fail OFFSITE_SOURCE_MISMATCH "$started"; return 1; }
  verified="$(date +%s)"
  duration="$((verified - started))"
  if ! printf '{"sourceSnapshotId":"%s","remoteSnapshotId":"%s","recoveryPointUnix":%s,"verifiedAt":"%s","verifiedUnix":%s,"durationSeconds":%s}\n' "$snapshot" "$remote_snapshot" "$point" "$(now_utc)" "$verified" "$duration" | write_atomic "$state/offsite-verified.json"; then fail OFFSITE_STATE_WRITE_FAILED "$started"; return 1; fi
  printf '{"at":"%s","status":"VERIFIED","sourceSnapshotId":"%s","remoteSnapshotId":"%s","durationSeconds":%s}\n' "$(now_utc)" "$snapshot" "$remote_snapshot" "$duration" | write_atomic "$state/offsite-last-attempt.json" || true
  printf '{"status":"OFFSITE_VERIFIED","sourceSnapshotId":"%s","remoteSnapshotId":"%s","recoveryPointUnix":%s,"durationSeconds":%s}\n' "$snapshot" "$remote_snapshot" "$point" "$duration"
)

case "$mode" in
  copy|verify) offsite_once ;;
  schedule)
    trap 'exit 0' TERM INT
    while :; do
      slot="$(date +%s)"
      mode=copy
      offsite_once || true
      elapsed="$(( $(date +%s) - slot ))"
      delay="$((interval - elapsed))"
      test "$delay" -gt 0 || delay=1
      sleep "$delay" & wait $! || true
    done ;;
esac
