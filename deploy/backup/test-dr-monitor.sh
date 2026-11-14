#!/bin/sh
set -eu
umask 077

# Run only in a disposable container with the source repository/state mounted read-only.
test "${DR_MONITOR_TEST_MODE:-}" = true
test "${RESTIC_REPOSITORY:-}" = /repository
test -r /state/verified.json
mkdir -p /fixture/remote /fixture/monitor /fixture/http
printf 'test-password\n' > /fixture/test-password
printf 'ok\n' > /fixture/http/index.html
snapshot="$(jq -er '.snapshotId' /state/verified.json)"
point="$(jq -er '.recoveryPointUnix' /state/verified.json)"

restic -r /fixture/remote --password-file /fixture/test-password init > /dev/null
restic --no-lock copy --repo2 /fixture/remote --password-file2 /fixture/test-password "$snapshot" > /dev/null
printf 'file:///fixture/http/index.html\n' > /fixture/primary-url

export DR_MONITOR_REPOSITORY=/fixture/remote
export DR_MONITOR_PASSWORD_FILE=/fixture/test-password
export DR_MONITOR_STATE_DIR=/fixture/monitor
export DR_PRIMARY_HEALTH_URL_FILE=/fixture/primary-url
export DR_MONITOR_NOW_UNIX="$((point + 301))"
/usr/local/bin/omnihub-dr-monitor verify
/usr/local/bin/omnihub-dr-monitor check

if DR_MONITOR_NOW_UNIX="$((point + 901))" /usr/local/bin/omnihub-dr-monitor check; then
  echo 'STALE_REMOTE_ACCEPTED' >&2
  exit 1
fi
jq -e 'select(.code == "REMOTE_BACKUP_STALE" and .ageSeconds == 901)' /fixture/monitor/events.jsonl > /dev/null
if DR_PRIMARY_HEALTH_URL_FILE=/fixture/missing /usr/local/bin/omnihub-dr-monitor check; then
  echo 'MISSING_PRIMARY_ACCEPTED' >&2
  exit 1
fi
mv /fixture/remote /fixture/unavailable
if /usr/local/bin/omnihub-dr-monitor check; then
  echo 'UNAVAILABLE_REPOSITORY_ACCEPTED' >&2
  exit 1
fi
mv /fixture/unavailable /fixture/remote
if DR_MONITOR_NOW_UNIX="$((point + 301 + 86401))" DR_MONITOR_MAX_AGE_SECONDS=100000 /usr/local/bin/omnihub-dr-monitor check; then
  echo 'STALE_RESTORE_VERIFICATION_ACCEPTED' >&2
  exit 1
fi
mkdir -p /fixture/invalid
head -c 80 /dev/zero > /fixture/invalid/database.dump
(cd /fixture/invalid && sha256sum database.dump > database.dump.sha256)
printf '{"formatVersion":1,"recoveryPointUnix":%s,"dumpBytes":80}\n' "$((point + 301))" > /fixture/invalid/backup-manifest.json
(cd /fixture/invalid && restic -r /fixture/remote --password-file /fixture/test-password backup --host omnihub-staging --tag postgres database.dump database.dump.sha256 backup-manifest.json > /dev/null)
if /usr/local/bin/omnihub-dr-monitor check; then
  echo 'TRUNCATED_REMOTE_ARCHIVE_COUNTED_TOWARD_RPO' >&2
  exit 1
fi
if /usr/local/bin/omnihub-dr-monitor verify; then
  echo 'TRUNCATED_REMOTE_ARCHIVE_ACCEPTED' >&2
  exit 1
fi
jq -e 'select(.code == "REMOTE_ARCHIVE_INVALID")' /fixture/monitor/events.jsonl > /dev/null
echo 'DISPOSABLE_MONITOR_PROBES_PASSED'
