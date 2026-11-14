#!/bin/sh
set -eu
umask 077

# Staging repository/state must be mounted read-only; all test writes stay in tmpfs.
test "${OFFSITE_TEST_MODE:-}" = true
test -r /state/verified.json
mkdir -p /fixture/source /fixture/remote /fixture/state
printf 'fixture-source-password\n' > /fixture/source-password
printf 'fixture-remote-password\n' > /fixture/test-password
printf '/fixture/remote\n' > /fixture/approved
snapshot="$(jq -er '.snapshotId' /state/verified.json)"
point="$(jq -er '.recoveryPointUnix' /state/verified.json)"

restic -r /fixture/source --password-file /fixture/source-password init > /dev/null
restic -r /fixture/remote --password-file /fixture/test-password init > /dev/null
restic --no-lock copy --repo2 /fixture/source --password-file2 /fixture/source-password "$snapshot" > /dev/null
source_snapshot="$(restic -r /fixture/source --password-file /fixture/source-password snapshots --json --host omnihub-staging --tag postgres | jq -er 'sort_by(.time) | last | .id')"
printf '{"snapshotId":"%s","recoveryPointUnix":%s}\n' "$source_snapshot" "$point" > /fixture/state/verified.json

export RESTIC_REPOSITORY=/fixture/source
export RESTIC_PASSWORD_FILE=/fixture/source-password
export BACKUP_STATE_DIR=/fixture/state
export OFFSITE_REPOSITORY=/fixture/remote
export OFFSITE_APPROVED_REPOSITORY_FILE=/fixture/approved
export OFFSITE_PASSWORD_FILE=/fixture/test-password
export OFFSITE_TEST_NOW_UNIX="$((point + 301))"
/usr/local/bin/omnihub-offsite copy
test -s /fixture/state/offsite-verified.json
jq -e --argjson point "$point" '.recoveryPointUnix == $point and .sourceSnapshotId != .remoteSnapshotId' /fixture/state/offsite-verified.json > /dev/null
cp /fixture/state/offsite-verified.json /fixture/pointer-before

if OFFSITE_TEST_NOW_UNIX="$((point + 901))" /usr/local/bin/omnihub-offsite verify; then
  echo 'STALE_SOURCE_PROMOTED' >&2
  exit 1
fi
cmp /fixture/pointer-before /fixture/state/offsite-verified.json

mv /fixture/remote /fixture/unavailable
if /usr/local/bin/omnihub-offsite verify; then
  echo 'UNAVAILABLE_REMOTE_ACCEPTED' >&2
  exit 1
fi
cmp /fixture/pointer-before /fixture/state/offsite-verified.json
echo 'DISPOSABLE_OFFSITE_PROBES_PASSED'
